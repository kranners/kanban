import type {
	Board,
	Layout,
	NodeRef,
	Point,
	Session,
} from "../shared/types.ts";
import { gridSize, snap, snapPoint } from "./grid.ts";
import type { BoardLayout, NodeKey, PlacedNode } from "./layout.ts";
import { defaultLayoutOptions, layoutBoard, nodeKey } from "./layout.ts";
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

const clearance = gridSize;
const searchRings = 64;

type Offset = { session: NodeKey; dx: number; dy: number };

export type Seeds = { tree: BoardLayout; offsets: Map<NodeKey, Offset> };

export type Arrangement = {
	nodes: Map<NodeKey, PlacedNode>;
	bounds: Bounds;
	auto: Map<NodeKey, Point>;
};

export function seedsOf(board: Board): Seeds {
	const tree = layoutBoard(board);
	const offsets = new Map<NodeKey, Offset>();
	for (const session of board.sessions) {
		const subagents = board.subagents.filter((a) => a.sessionId === session.id);
		if (subagents.length === 0) continue;
		const key = nodeKey({ kind: "session", id: session.id });
		const own = layoutBoard({
			...board,
			sessions: [session],
			subagents,
			links: [],
			messages: [],
		});
		const root = own.nodes.get(key);
		if (!root) continue;
		for (const node of own.nodes.values()) {
			if (node.key === key) continue;
			offsets.set(node.key, {
				session: key,
				dx: node.x - root.x,
				dy: node.y - root.y,
			});
		}
	}
	return { tree, offsets };
}

export function near(a: Rect, b: Rect, gap: number): boolean {
	return (
		a.x < b.x + b.w + gap &&
		b.x < a.x + a.w + gap &&
		a.y < b.y + b.h + gap &&
		b.y < a.y + a.h + gap
	);
}

type Project = { name: string; area: Rect };

function areaOf(rects: Iterable<Rect>): Rect {
	const { x, y, width, height } = boundsOf(rects);
	return { x, y, w: width, h: height };
}

export function framedArea(area: Rect): Rect {
	return {
		x: area.x - groupPadding,
		y: area.y - groupLabelSpace,
		w: area.w + groupPadding * 2,
		h: area.h + groupPadding + groupLabelSpace,
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
): Point {
	const fits = (by: Point) =>
		(by.x === 0 && by.y === 0) ||
		rects.every((rect) => {
			const moved = { ...rect, x: rect.x + by.x, y: rect.y + by.y };
			return taken.every((other) => !near(moved, other, clearance));
		});
	return nearestFree(wanted, fits) ?? fallback;
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
): Arrangement {
	const nodes = new Map<NodeKey, PlacedNode>();
	const occupied: Rect[] = [];
	const projects: Project[] = [];
	const auto = new Map<NodeKey, Point>();
	const sessionProject = new Map(board.sessions.map((s) => [s.id, s.project]));
	const joining = (name: string, area: Rect) =>
		projects.filter(
			(project) =>
				project.name === name && within(project.area, area, groupReach),
		);
	const claim = (name: string | undefined, rects: Rect[]) => {
		occupied.push(...rects);
		if (name === undefined || rects.length === 0) return;
		const area = areaOf(rects);
		const joined = joining(name, area);
		for (const project of joined) projects.splice(projects.indexOf(project), 1);
		projects.push({ name, area: areaOf([area, ...joined.map((p) => p.area)]) });
	};
	const apart = (name: string, rects: Rect[]) => {
		const area = areaOf(rects);
		const joined = joining(name, area).map((project) => project.area);
		const before = joined.length > 0 ? framedArea(areaOf(joined)) : null;
		const after = framedArea(areaOf([area, ...joined]));
		return projects.every((other) => {
			if (other.name === name) return true;
			const theirs = framedArea(other.area);
			if (before && near(before, theirs, clearance)) return true;
			return !near(after, theirs, clearance);
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
	const free = (rects: Rect[], project: string) =>
		rects.every((r) => occupied.every((o) => !near(r, o, clearance))) &&
		apart(project, rects);
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
	const pinned = (s: Session) =>
		saved[nodeKey({ kind: "session", id: s.id })]?.pinned === true;

	for (const s of savedSessions.filter(pinned)) {
		const ref: NodeRef = { kind: "session", id: s.id };
		const key = nodeKey(ref);
		const rect = sessionRect(key, savedSpot(key));
		put(key, ref, rect);
		claim(s.project, [rect]);
	}
	for (const a of board.subagents) {
		const ref: NodeRef = { kind: "subagent", id: a.id };
		const key = nodeKey(ref);
		const placement = saved[key];
		if (!placement) continue;
		const rect = { x: placement.x, y: placement.y, ...subagentSize };
		put(key, ref, rect);
		claim(sessionProject.get(a.sessionId), [rect]);
	}
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
		const shift = clearShift(
			natural.map(([, rect]) => rect),
			[...occupied, ...reserved],
		);
		for (const [follower, rect] of natural)
			nudged.set(follower, {
				...rect,
				x: rect.x + shift.x,
				y: rect.y + shift.y,
			});
		claim(
			s.project,
			natural.flatMap(([follower]) => nudged.get(follower) ?? []),
		);
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
		const gap = groupPadding + groupLabelSpace + clearance;
		return { x: start.x, y: snap(taken.y + taken.height + gap) };
	};

	for (const s of savedSessions.filter((s) => !pinned(s))) {
		const ref: NodeRef = { kind: "session", id: s.id };
		const key = nodeKey(ref);
		const fits = (point: Point) =>
			free(footprint(key, sessionRect(key, point)), s.project);
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
		const fits = (point: Point) => free(footprint(key, at(point)), s.project);
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
		const session = offset ? nodes.get(offset.session) : undefined;
		if (offset && session) {
			const rect = nudged.get(key) ?? followerRect(session, offset);
			put(key, ref, rect, offset.session);
			continue;
		}
		const point = treePoint(key);
		if (point) put(key, ref, { ...point, ...subagentSize });
	}

	return { nodes, bounds: boundsOf(nodes.values()), auto };
}
