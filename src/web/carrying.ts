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
import { board } from "./state.ts";

type Passenger = { key: NodeKey; at: Point; size: Partial<Placement> };

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
		return node
			? [{ key, at: { x: node.x, y: node.y }, size: sizeOf(key) }]
			: [];
	});
	const listed = new Set(notes.map((note) => note.id));
	return {
		nodes: passengers,
		notes: [...notes, ...carried.notes.filter((note) => !listed.has(note.id))],
	};
}

function placementOf(passenger: Passenger, by: Point): Placement {
	return {
		x: passenger.at.x + by.x,
		y: passenger.at.y + by.y,
		...passenger.size,
		pinned: true,
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

let carrying: { key: NodeKey; origin: Point; load: Load } | null = null;

function carryingFor(key: NodeKey) {
	if (carrying?.key === key) return carrying;
	const load = loadOf([key]);
	const origin = load.nodes.find((passenger) => passenger.key === key)?.at;
	carrying = origin ? { key, origin, load } : null;
	return carrying;
}

export function arrangeCard(gesture: Arranging): void {
	const carried = gesture.mode === "move" ? carryingFor(gesture.key) : null;
	if (!carried) {
		arrangeNode(gesture);
		return;
	}
	const by = {
		x: gesture.rect.x - carried.origin.x,
		y: gesture.rect.y - carried.origin.y,
	};
	if (gesture.phase === "move") previewLoad(carried.load, by);
	else {
		carrying = null;
		if (gesture.phase === "drop") commitLoad(carried.load, by);
		else cancelLoad(carried.load);
	}
}
