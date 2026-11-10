import type {
	Board,
	Layout,
	NodeRef,
	Point,
	Region,
	Session,
} from "../shared/types.ts";
import { gridSize, snap, snapPoint } from "./grid.ts";
import type { BoardLayout, NodeKey, PlacedNode } from "./layout.ts";
import {
	defaultLayoutOptions,
	type LayoutOptions,
	layoutBoard,
	nodeKey,
} from "./layout.ts";
import type { Size } from "./viewport.ts";

export type Rect = { x: number; y: number; w: number; h: number };

export type Bounds = Point & Size;

export const sessionSize = defaultLayoutOptions.session;
export const subagentSize = defaultLayoutOptions.subagent;
export const minSessionSize = { w: 10 * gridSize, h: 9 * gridSize };
export const maxSessionSize = { w: 40 * gridSize, h: 30 * gridSize };

export const groupReach = 4 * gridSize;
export const groupPadding = gridSize;
export const groupLabelSpace = gridSize + 8;
/** Room above a frame's cards: its label bar, then one grid cell, as below. */
export const groupHeadroom = groupLabelSpace + groupPadding;

/** The gap every card, note, sticker and project frame keeps from the next. */
export const clearance = gridSize;
const searchRings = 64;

type Offset = { session: NodeKey; dx: number; dy: number };

export type Seeds = { tree: BoardLayout; offsets: Map<NodeKey, Offset> };

export type Arrangement = {
	nodes: Map<NodeKey, PlacedNode>;
	/** Butler's cards that own subagents, as the nodes those subagents follow; drawn as cards, not here. */
	anchors: Map<NodeKey, PlacedNode>;
	bounds: Bounds;
	auto: Map<NodeKey, Point>;
};

/** One of Butler's cards, which owns subagents as a session does. */
export type Anchor = Rect & { id: string };

/** Where each of an owner's subagents sits relative to it, as the tree lays them out under a session. */
export function followerOffsets(
	board: Board,
	ownerId: string,
	options: LayoutOptions = defaultLayoutOptions,
): Map<NodeKey, Offset> {
	const offsets = new Map<NodeKey, Offset>();
	const subagents = board.subagents.filter((a) => a.sessionId === ownerId);
	if (subagents.length === 0) return offsets;
	const key = nodeKey({ kind: "session", id: ownerId });
	const owner = board.sessions.find((s) => s.id === ownerId) ?? {
		id: ownerId,
		startedAt: 0,
	};
	const own = layoutBoard(
		{
			...board,
			sessions: [owner as Session],
			subagents,
			links: [],
			messages: [],
		},
		options,
	);
	const root = own.nodes.get(key);
	if (!root) return offsets;
	for (const node of own.nodes.values()) {
		if (node.key === key) continue;
		offsets.set(node.key, {
			session: key,
			dx: node.x - root.x,
			dy: node.y - root.y,
		});
	}
	return offsets;
}

/**
 * The tree seeds and every follower's offset from its owner: a session, or
 * one of Butler's cards, whose subagents sit under it as a session's do.
 */
export function seedsOf(board: Board, cardIds: readonly string[] = []): Seeds {
	const cards = new Set(cardIds);
	const tree = layoutBoard({
		...board,
		subagents: board.subagents.filter((a) => !cards.has(a.sessionId)),
	});
	const offsets = new Map<NodeKey, Offset>();
	const owners = [
		...board.sessions.map((s) => [s.id, defaultLayoutOptions] as const),
		...[...cards].map((id) => [id, cardFollowers] as const),
	];
	for (const [id, options] of owners) {
		for (const [key, offset] of followerOffsets(board, id, options)) {
			offsets.set(key, offset);
		}
	}
	return { tree, offsets };
}

/** A Butler card's leaf subagents stand in one column under it, since Tidy lays cards out in a grid; one with its own subagents branches beside them. */
const cardFollowers: LayoutOptions = {
	...defaultLayoutOptions,
	subagentColumns: 1,
};

/** How far a card's subagents reach below it and out to its left, and how wide they stand, so nothing is put where they go. */
export function cardFollowerReach(
	board: Board,
	cardId: string,
): { below: number; left: number; w: number } {
	const offsets = [...followerOffsets(board, cardId, cardFollowers).values()];
	if (offsets.length === 0) return { below: 0, left: 0, w: 0 };
	const bottom = Math.max(...offsets.map((o) => o.dy)) + subagentSize.h;
	const left = Math.min(0, ...offsets.map((o) => o.dx));
	const right = Math.max(
		sessionSize.w,
		...offsets.map((o) => o.dx + subagentSize.w),
	);
	return { below: bottom - sessionSize.h, left: -left, w: right - left };
}

export function near(a: Rect, b: Rect, gap: number): boolean {
	return (
		a.x < b.x + b.w + gap &&
		b.x < a.x + a.w + gap &&
		a.y < b.y + b.h + gap &&
		b.y < a.y + a.h + gap
	);
}

type Project = { name: string; areas: Rect[] };

function frameOf(project: Project): Rect | null {
	return project.areas.length > 1 ? framedArea(areaOf(project.areas)) : null;
}

export function belongsTo(region: { cwd: string }, cwd: string): boolean {
	const root = region.cwd.replace(/\/+$/, "");
	return cwd === region.cwd || cwd.startsWith(`${root}/`);
}

export function centreOf(rect: Rect): Point {
	return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function inside(rect: Rect, point: Point): boolean {
	return (
		point.x > rect.x &&
		point.x < rect.x + rect.w &&
		point.y > rect.y &&
		point.y < rect.y + rect.h
	);
}

export function housedBy(region: Region, cwd: string, rect: Rect): boolean {
	return belongsTo(region, cwd) && inside(region, centreOf(rect));
}

export function areaOf(rects: Iterable<Rect>): Rect {
	const { x, y, width, height } = boundsOf(rects);
	return { x, y, w: width, h: height };
}

export function framedArea(area: Rect): Rect {
	return {
		x: area.x - groupPadding,
		y: area.y - groupHeadroom,
		w: area.w + groupPadding * 2,
		h: area.h + groupPadding + groupHeadroom,
	};
}

export function within(a: Rect, b: Rect, reach: number): boolean {
	return (
		a.x <= b.x + b.w + reach &&
		b.x <= a.x + a.w + reach &&
		a.y <= b.y + b.h + reach &&
		b.y <= a.y + a.h + reach
	);
}

export function boundsOf(rects: Iterable<Rect>): Bounds {
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const r of rects) {
		left = Math.min(left, r.x);
		top = Math.min(top, r.y);
		right = Math.max(right, r.x + r.w);
		bottom = Math.max(bottom, r.y + r.h);
	}
	if (left > right) return { x: 0, y: 0, width: 0, height: 0 };
	return { x: left, y: top, width: right - left, height: bottom - top };
}

function ring(radius: number): Point[] {
	const cells: Point[] = [];
	for (let i = -radius; i <= radius; i++) {
		for (let j = -radius; j <= radius; j++) {
			if (Math.max(Math.abs(i), Math.abs(j)) === radius)
				cells.push({ x: i, y: j });
		}
	}
	return cells.sort(
		(a, b) =>
			a.x * a.x + a.y * a.y - (b.x * b.x + b.y * b.y) || a.y - b.y || a.x - b.x,
	);
}

export function nearestFree(
	start: Point,
	fits: (at: Point) => boolean,
): Point | null {
	if (fits(start)) return start;
	for (let radius = 1; radius <= searchRings; radius++) {
		for (const cell of ring(radius)) {
			const at = {
				x: start.x + cell.x * gridSize,
				y: start.y + cell.y * gridSize,
			};
			if (fits(at)) return at;
		}
	}
	return null;
}

export function clearSpot(rect: Rect, taken: readonly Rect[]): Point {
	const fits = (at: Point) =>
		taken.every((r) => !near({ ...rect, ...at }, r, clearance));
	return (
		nearestFree({ x: rect.x, y: rect.y }, fits) ?? { x: rect.x, y: rect.y }
	);
}

export function clearShift(
	rects: readonly Rect[],
	taken: readonly Rect[],
	from: Point = { x: 0, y: 0 },
): Point {
	const { x, y, width: w, height: h } = boundsOf(rects);
	const spot = clearSpot({ x: x + from.x, y: y + from.y, w, h }, taken);
	return { x: spot.x - x, y: spot.y - y };
}

export function clearMove(
	rects: readonly Rect[],
	taken: readonly Rect[],
	wanted: Point,
	fallback: Point,
	allowed: (by: Point) => boolean = () => true,
): Point {
	const fits = (by: Point) =>
		(by.x === 0 && by.y === 0) ||
		(rects.every((rect) => {
			const moved = { ...rect, x: rect.x + by.x, y: rect.y + by.y };
			return taken.every((other) => !near(moved, other, clearance));
		}) &&
			allowed(by));
	return nearestFree(wanted, fits) ?? fallback;
}

/** Whether `inner` lies wholly within `outer`. */
export function holds(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	);
}

/**
 * Whether a rect keeps a grid cell from every loose rect, and from every
 * frame unless it sits inside that frame's padding, below its label bar.
 */
export function spacedFrom(
	rect: Rect,
	loose: readonly Rect[],
	frames: readonly Rect[] = [],
): boolean {
	return (
		loose.every((other) => !near(rect, other, clearance)) &&
		frames.every(
			(frame) => !near(rect, frame, clearance) || holds(unframed(frame), rect),
		)
	);
}

/** The step nearest `wanted` that leaves every rect fitting, else `fallback`. */
export function spacedMove(
	rects: readonly Rect[],
	wanted: Point,
	fallback: Point,
	fits: (rect: Rect) => boolean,
): Point {
	const fitsBy = (by: Point) =>
		(by.x === 0 && by.y === 0) ||
		rects.every((rect) =>
			fits({ ...rect, x: rect.x + by.x, y: rect.y + by.y }),
		);
	return nearestFree(wanted, fitsBy) ?? fallback;
}

/**
 * The wanted size if it fits, else the wanted size along whichever axis
 * still fits (when the axes may change apart), else the last size that did.
 */
export function spacedResize<T extends Rect>(
	wanted: T,
	last: T,
	fits: (rect: T) => boolean,
	apart = true,
): T {
	const tries = apart
		? [wanted, { ...wanted, h: last.h }, { ...wanted, w: last.w }]
		: [wanted];
	return tries.find(fits) ?? last;
}

export function unframed(frame: Rect): Rect {
	return {
		x: frame.x + groupPadding,
		y: frame.y + groupHeadroom,
		w: frame.w - groupPadding * 2,
		h: frame.h - groupPadding - groupHeadroom,
	};
}

export function growsApart(
	area: Rect,
	own: readonly Rect[],
	others: readonly Rect[],
): boolean {
	const joined = own.filter((group) => within(group, area, groupReach));
	if (joined.length === 0) return true;
	const grown = framedArea(areaOf([area, ...joined]));
	return others.every(
		(other) =>
			joined.some((group) => near(framedArea(group), other, clearance)) ||
			!near(grown, other, clearance),
	);
}

function sessionParents(board: Board): Map<NodeKey, NodeKey> {
	const ownerOf = new Map(board.subagents.map((a) => [a.id, a.sessionId]));
	const sessionOf = (ref: NodeRef) =>
		ref.kind === "session" ? ref.id : ownerOf.get(ref.id);
	const parents = new Map<NodeKey, NodeKey>();
	for (const link of board.links) {
		if (link.to.kind !== "session" || link.kind === "subagent") continue;
		const from = sessionOf(link.from);
		const child = nodeKey(link.to);
		if (!from || parents.has(child)) continue;
		const parent = nodeKey({ kind: "session", id: from });
		if (parent !== child) parents.set(child, parent);
	}
	return parents;
}

export function arrange(
	board: Board,
	saved: Layout,
	seeds: Seeds,
	remembered: ReadonlyMap<NodeKey, Point>,
	reserved: readonly Rect[] = [],
	regions: readonly Region[] = [],
	cards: readonly Anchor[] = [],
): Arrangement {
	const nodes = new Map<NodeKey, PlacedNode>();
	const anchors = new Map<NodeKey, PlacedNode>();
	const occupied: Rect[] = [];
	const projects: Project[] = [];
	const auto = new Map<NodeKey, Point>();
	const joining = (name: string, area: Rect) =>
		projects.filter(
			(project) =>
				project.name === name &&
				project.areas.some((own) => within(own, area, groupReach)),
		);
	const register = (name: string | undefined, rects: Rect[]) => {
		if (name === undefined || rects.length === 0) return;
		const area = areaOf(rects);
		const joined = joining(name, area);
		for (const project of joined) projects.splice(projects.indexOf(project), 1);
		projects.push({
			name,
			areas: [area, ...joined.flatMap((project) => project.areas)],
		});
	};
	const claim = (name: string | undefined, rects: Rect[]) => {
		occupied.push(...rects);
		register(name, rects);
	};
	const peers = new Map<string, number>();
	for (const s of board.sessions)
		peers.set(s.project, (peers.get(s.project) ?? 0) + 1);
	const apart = (session: Session, rects: Rect[]) => {
		const area = areaOf(rects);
		const joined = joining(session.project, area);
		const grown =
			joined.length > 0 || (peers.get(session.project) ?? 0) > 1
				? framedArea(areaOf([area, ...joined.flatMap((p) => p.areas)]))
				: null;
		const ownRegions = regions.every(
			(region) =>
				belongsTo(region, session.cwd) ||
				!near(grown ?? area, region, clearance),
		);
		if (!ownRegions || !grown) return ownRegions;
		const framedBefore = joined.flatMap((project) => frameOf(project) ?? []);
		return projects.every((other) => {
			const theirs = joined.includes(other) ? null : frameOf(other);
			if (!theirs) return true;
			if (framedBefore.some((frame) => near(frame, theirs, clearance)))
				return true;
			return !near(grown, theirs, clearance);
		});
	};

	const followersOf = new Map<NodeKey, NodeKey[]>();
	for (const a of board.subagents) {
		const key = nodeKey({ kind: "subagent", id: a.id });
		const offset = seeds.offsets.get(key);
		if (!offset || saved[key]) continue;
		followersOf.set(offset.session, [
			...(followersOf.get(offset.session) ?? []),
			key,
		]);
	}

	const followerRect = (session: Rect, offset: Offset): Rect => ({
		x: snap(session.x + offset.dx + (session.w - sessionSize.w) / 2),
		y: snap(session.y + offset.dy + session.h - sessionSize.h),
		...subagentSize,
	});
	const footprint = (key: NodeKey, rect: Rect): Rect[] => [
		rect,
		...(followersOf.get(key) ?? []).flatMap((f) => {
			const offset = seeds.offsets.get(f);
			return offset ? [followerRect(rect, offset)] : [];
		}),
	];
	const free = (rects: Rect[], session: Session) => {
		const area = areaOf(rects);
		return (
			occupied.every(
				(o) =>
					!near(area, o, clearance) ||
					rects.every((r) => !near(r, o, clearance)),
			) && apart(session, rects)
		);
	};
	const put = (key: NodeKey, ref: NodeRef, rect: Rect, follows?: NodeKey) => {
		nodes.set(key, {
			key,
			ref,
			family: seeds.tree.nodes.get(key)?.family ?? 0,
			...rect,
			...(follows ? { follows } : {}),
		});
	};
	const treePoint = (key: NodeKey): Point | null => {
		const node = seeds.tree.nodes.get(key);
		return node ? snapPoint(node) : null;
	};

	const owned = new Set(board.subagents.map((a) => a.sessionId));
	for (const card of cards) {
		if (!owned.has(card.id)) continue;
		const ref: NodeRef = { kind: "session", id: card.id };
		const key = nodeKey(ref);
		anchors.set(key, {
			key,
			ref,
			family: 0,
			x: card.x,
			y: card.y,
			w: card.w,
			h: card.h,
		});
	}
	const byStart = (a: Session, b: Session) =>
		a.startedAt - b.startedAt || a.id.localeCompare(b.id);
	const savedSpot = (key: NodeKey): Point => ({
		x: saved[key]?.x ?? 0,
		y: saved[key]?.y ?? 0,
	});
	const sessionRect = (key: NodeKey, at: Point): Rect => ({
		...at,
		w: saved[key]?.w ?? sessionSize.w,
		h: saved[key]?.h ?? sessionSize.h,
	});
	const savedSessions = board.sessions
		.filter((s) => saved[nodeKey({ kind: "session", id: s.id })])
		.sort(byStart);
	const homeOf = (s: Session) => {
		const key = nodeKey({ kind: "session", id: s.id });
		const rect = sessionRect(key, savedSpot(key));
		return regions.find((region) => housedBy(region, s.cwd, rect));
	};
	const placedByHand = (s: Session) =>
		saved[nodeKey({ kind: "session", id: s.id })]?.pinned === true;
	const inRegionBesides = (home: Region | undefined) => (rect: Rect) =>
		home !== undefined &&
		regions.some((region) => region !== home && inside(region, centreOf(rect)));

	for (const s of savedSessions.filter(placedByHand)) {
		const ref: NodeRef = { kind: "session", id: s.id };
		const key = nodeKey(ref);
		const rect = sessionRect(key, savedSpot(key));
		put(key, ref, rect);
		occupied.push(rect);
	}
	for (const a of board.subagents) {
		const ref: NodeRef = { kind: "subagent", id: a.id };
		const key = nodeKey(ref);
		const placement = saved[key];
		if (!placement) continue;
		const rect = { x: placement.x, y: placement.y, ...subagentSize };
		put(key, ref, rect);
		occupied.push(rect);
	}
	const held = new Set<string>();
	for (const s of savedSessions) {
		if (placedByHand(s) || !homeOf(s)) continue;
		const ref: NodeRef = { kind: "session", id: s.id };
		const key = nodeKey(ref);
		const rect = sessionRect(key, savedSpot(key));
		if (occupied.some((other) => near(rect, other, clearance))) continue;
		put(key, ref, rect);
		occupied.push(rect);
		held.add(s.id);
	}
	const cardFollowers = new Map<NodeKey, Rect>();
	for (const [cardKey, card] of anchors) {
		const natural = board.subagents.flatMap((a) => {
			const key = nodeKey({ kind: "subagent", id: a.id });
			const offset = seeds.offsets.get(key);
			return offset?.session === cardKey && !saved[key]
				? [[key, followerRect(card, offset)] as const]
				: [];
		});
		if (natural.length === 0) continue;
		const others = reserved.filter(
			(rect) => (rect as { id?: string }).id !== card.ref.id,
		);
		const shift = clearShift(
			natural.map(([, rect]) => rect),
			[...occupied, ...others],
		);
		for (const [key, rect] of natural) {
			const moved = { ...rect, x: rect.x + shift.x, y: rect.y + shift.y };
			cardFollowers.set(key, moved);
			occupied.push(moved);
		}
	}

	const pinned = (s: Session) => placedByHand(s) || held.has(s.id);
	const nudged = new Map<NodeKey, Rect>();
	for (const s of savedSessions.filter(pinned)) {
		const key = nodeKey({ kind: "session", id: s.id });
		const session = nodes.get(key);
		if (!session) continue;
		const natural = (followersOf.get(key) ?? []).flatMap((follower) => {
			const offset = seeds.offsets.get(follower);
			return offset ? [[follower, followerRect(session, offset)] as const] : [];
		});
		if (natural.length === 0) continue;
		const movesAside = inRegionBesides(homeOf(s));
		const shift = clearShift(
			natural.map(([, rect]) => rect),
			[...occupied, ...reserved].filter((rect) => !movesAside(rect)),
		);
		for (const [follower, rect] of natural)
			nudged.set(follower, {
				...rect,
				x: rect.x + shift.x,
				y: rect.y + shift.y,
			});
		occupied.push(
			...natural.flatMap(([follower]) => nudged.get(follower) ?? []),
		);
	}
	for (const s of savedSessions.filter(pinned)) {
		const key = nodeKey({ kind: "session", id: s.id });
		const session = nodes.get(key);
		if (!session) continue;
		const followers = (followersOf.get(key) ?? []).flatMap(
			(follower) => nudged.get(follower) ?? [],
		);
		register(s.project, [session, ...followers]);
	}

	const parents = sessionParents(board);
	const seedFor = (key: NodeKey): Point => {
		const own = treePoint(key);
		const parentKey = parents.get(key);
		const parent = parentKey ? nodes.get(parentKey) : undefined;
		const parentSeed = parentKey ? seeds.tree.nodes.get(parentKey) : undefined;
		const childSeed = seeds.tree.nodes.get(key);
		if (parent && parentSeed && childSeed) {
			return snapPoint({
				x: parent.x + childSeed.x - parentSeed.x,
				y: parent.y + parent.h - parentSeed.h + childSeed.y - parentSeed.y,
			});
		}
		return own ?? { x: 0, y: 0 };
	};

	const below = (start: Point): Point => {
		const taken = boundsOf(occupied);
		const gap = groupPadding + groupHeadroom + clearance;
		return { x: start.x, y: snap(taken.y + taken.height + gap) };
	};

	for (const s of savedSessions.filter((s) => !pinned(s))) {
		const ref: NodeRef = { kind: "session", id: s.id };
		const key = nodeKey(ref);
		const fits = (point: Point) =>
			free(footprint(key, sessionRect(key, point)), s);
		const spot = nearestFree(savedSpot(key), fits) ?? below(savedSpot(key));
		put(key, ref, sessionRect(key, spot));
		claim(s.project, footprint(key, sessionRect(key, spot)));
	}

	occupied.push(...reserved);

	const unplaced = board.sessions
		.filter((s) => !saved[nodeKey({ kind: "session", id: s.id })])
		.sort(byStart);
	for (const s of unplaced) {
		const ref: NodeRef = { kind: "session", id: s.id };
		const key = nodeKey(ref);
		const at = (point: Point): Rect => ({ ...point, ...sessionSize });
		const fits = (point: Point) => free(footprint(key, at(point)), s);
		const previous = remembered.get(key);
		const start = seedFor(key);
		const spot =
			(previous && fits(previous) ? previous : null) ??
			nearestFree(start, fits) ??
			below(start);
		put(key, ref, at(spot));
		claim(s.project, footprint(key, at(spot)));
		auto.set(key, spot);
	}

	for (const a of board.subagents) {
		const ref: NodeRef = { kind: "subagent", id: a.id };
		const key = nodeKey(ref);
		if (saved[key]) continue;
		const offset = seeds.offsets.get(key);
		const session = offset
			? (nodes.get(offset.session) ?? anchors.get(offset.session))
			: undefined;
		if (offset && session) {
			const rect =
				nudged.get(key) ??
				cardFollowers.get(key) ??
				followerRect(session, offset);
			put(key, ref, rect, offset.session);
			continue;
		}
		const point = treePoint(key);
		if (point) put(key, ref, { ...point, ...subagentSize });
	}

	return { nodes, anchors, bounds: boundsOf(nodes.values()), auto };
}
