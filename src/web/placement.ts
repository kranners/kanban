import type { Board, Layout, NodeRef, Point } from "../shared/types.ts";
import { gridSize, snap, snapPoint } from "./grid.ts";
import type { BoardLayout, NodeKey, PlacedNode } from "./layout.ts";
import { defaultLayoutOptions, layoutBoard, nodeKey } from "./layout.ts";
import type { Size } from "./viewport.ts";

export type Rect = { x: number; y: number; w: number; h: number };

export type Bounds = Point & Size;

export const sessionSize = defaultLayoutOptions.session;
export const subagentSize = defaultLayoutOptions.subagent;
export const minSessionSize = { w: 10 * gridSize, h: 7 * gridSize };
export const maxSessionSize = { w: 40 * gridSize, h: 30 * gridSize };

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
	const auto = new Map<NodeKey, Point>();

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
	const free = (rects: Rect[]) =>
		rects.every((r) => occupied.every((o) => !near(r, o, clearance)));
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

	for (const s of board.sessions) {
		const ref: NodeRef = { kind: "session", id: s.id };
		const key = nodeKey(ref);
		const placement = saved[key];
		if (!placement) continue;
		const rect = {
			x: placement.x,
			y: placement.y,
			w: placement.w ?? sessionSize.w,
			h: placement.h ?? sessionSize.h,
		};
		put(key, ref, rect);
		occupied.push(...footprint(key, rect));
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
		return { x: start.x, y: snap(taken.y + taken.height + clearance) };
	};

	occupied.push(...reserved);

	const unplaced = board.sessions
		.filter((s) => !saved[nodeKey({ kind: "session", id: s.id })])
		.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	for (const s of unplaced) {
		const ref: NodeRef = { kind: "session", id: s.id };
		const key = nodeKey(ref);
		const at = (point: Point): Rect => ({ ...point, ...sessionSize });
		const fits = (point: Point) => free(footprint(key, at(point)));
		const previous = remembered.get(key);
		const start = seedFor(key);
		const spot =
			(previous && fits(previous) ? previous : null) ??
			nearestFree(start, fits) ??
			below(start);
		put(key, ref, at(spot));
		occupied.push(...footprint(key, at(spot)));
		auto.set(key, spot);
	}

	for (const a of board.subagents) {
		const ref: NodeRef = { kind: "subagent", id: a.id };
		const key = nodeKey(ref);
		if (saved[key]) continue;
		const offset = seeds.offsets.get(key);
		const session = offset ? nodes.get(offset.session) : undefined;
		if (offset && session) {
			put(key, ref, followerRect(session, offset), offset.session);
			continue;
		}
		const point = treePoint(key);
		if (point) put(key, ref, { ...point, ...subagentSize });
	}

	return { nodes, bounds: boundsOf(nodes.values()), auto };
}
