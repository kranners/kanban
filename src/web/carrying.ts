import type { Annotation, Placement, Point } from "../shared/types.ts";
import { preview, save, current as shownAnnotations } from "./annotations.ts";
import type { Arranging } from "./arrangement.ts";
import {
	arrangement,
	arrangeNode,
	cancelPlacement,
	commitPlacement,
	groups,
	previewPlacement,
	savedPlacement,
} from "./arrangement.ts";
import { carriedWith } from "./carry.ts";
import type { NodeKey } from "./layout.ts";
import { moved } from "./notes.ts";
import type { Rect } from "./placement.ts";
import { clearMove, framedArea } from "./placement.ts";
import { belongsTo } from "./regions.ts";
import { board } from "./state.ts";

type Passenger = {
	key: NodeKey;
	rect: Rect;
	size: Partial<Placement>;
	pinned: boolean;
};

export type Load = { nodes: Passenger[]; notes: Annotation[] };

function sizeOf(key: NodeKey): Partial<Placement> {
	const saved = savedPlacement(key);
	return saved?.w !== undefined && saved.h !== undefined
		? { w: saved.w, h: saved.h }
		: {};
}

export function loadOf(
	roots: readonly NodeKey[],
	notes: readonly Annotation[] = [],
): Load {
	const placed = arrangement.peek()?.nodes;
	const current = board.peek();
	if (!placed || !current) return { nodes: [], notes: [...notes] };
	const carried = carriedWith(
		roots,
		current,
		placed,
		Object.values(shownAnnotations.peek()),
		groups.peek(),
	);
	const passengers = [...roots, ...carried.nodes].flatMap((key) => {
		const node = placed.get(key);
		if (!node) return [];
		const { x, y, w, h } = node;
		const pinned = roots.includes(key) || savedPlacement(key)?.pinned === true;
		return [{ key, rect: { x, y, w, h }, size: sizeOf(key), pinned }];
	});
	const listed = new Set(notes.map((note) => note.id));
	return {
		nodes: passengers,
		notes: [...notes, ...carried.notes.filter((note) => !listed.has(note.id))],
	};
}

export function footprintOf(load: Load): Rect[] {
	const carried = new Set(load.nodes.map((passenger) => passenger.key));
	const followers = [...(arrangement.peek()?.nodes.values() ?? [])].filter(
		(node) => node.follows !== undefined && carried.has(node.follows),
	);
	return [...load.nodes.map((passenger) => passenger.rect), ...followers];
}

function placementOf(passenger: Passenger, by: Point): Placement {
	return {
		x: passenger.rect.x + by.x,
		y: passenger.rect.y + by.y,
		...passenger.size,
		...(passenger.pinned ? { pinned: true as const } : {}),
	};
}

function movedNotes(load: Load, by: Point): Annotation[] {
	return load.notes.map((note) => moved(note, by.x, by.y));
}

export function previewLoad(load: Load, by: Point): void {
	for (const passenger of load.nodes)
		previewPlacement(passenger.key, placementOf(passenger, by));
	if (load.notes.length > 0) preview(movedNotes(load, by));
}

export function commitLoad(load: Load, by: Point): void {
	for (const passenger of load.nodes)
		void commitPlacement(passenger.key, placementOf(passenger, by));
	if (load.notes.length > 0) save(movedNotes(load, by));
}

export function cancelLoad(load: Load): void {
	for (const passenger of load.nodes) cancelPlacement(passenger.key);
	if (load.notes.length > 0) save(load.notes);
}

function otherProjectsThan(key: NodeKey): Rect[] {
	const current = board.peek();
	const id = key.slice(key.indexOf(":") + 1);
	const sessionId = key.startsWith("subagent:")
		? current?.subagents.find((agent) => agent.id === id)?.sessionId
		: id;
	const session = current?.sessions.find((s) => s.id === sessionId);
	if (!session) return [];
	return groups
		.peek()
		.filter((group) =>
			group.region
				? !belongsTo(group.region, session.cwd)
				: group.project !== session.project,
		)
		.map((group) => group.frame);
}

type Carrying = {
	key: NodeKey;
	origin: Point;
	load: Load;
	framed: Rect[];
	others: Rect[];
	by: Point;
};

let carrying: Carrying | null = null;

function startCarrying(key: NodeKey): Carrying | null {
	const load = loadOf([key]);
	const root = load.nodes.find((passenger) => passenger.key === key);
	if (!root) return null;
	return {
		key,
		origin: { x: root.rect.x, y: root.rect.y },
		load,
		framed: footprintOf(load).map(framedArea),
		others: otherProjectsThan(key),
		by: { x: 0, y: 0 },
	};
}

export function arrangeCard(gesture: Arranging): void {
	if (gesture.mode === "move" && gesture.phase === "move")
		if (carrying?.key !== gesture.key) carrying = startCarrying(gesture.key);
	const carried =
		gesture.mode === "move" && carrying?.key === gesture.key ? carrying : null;
	if (!carried) {
		arrangeNode(gesture);
		return;
	}
	if (gesture.phase === "cancel") {
		carrying = null;
		cancelLoad(carried.load);
		return;
	}
	carried.by = clearMove(
		carried.framed,
		carried.others,
		{
			x: gesture.rect.x - carried.origin.x,
			y: gesture.rect.y - carried.origin.y,
		},
		carried.by,
	);
	if (gesture.phase === "move") {
		previewLoad(carried.load, carried.by);
		return;
	}
	carrying = null;
	if (carried.by.x !== 0 || carried.by.y !== 0) {
		commitLoad(carried.load, carried.by);
		return;
	}
	cancelLoad(carried.load);
	arrangeNode({ ...gesture, rect: { ...gesture.rect, ...carried.origin } });
}
