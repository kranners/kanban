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
import type { Group } from "./groups.ts";
import type { NodeKey } from "./layout.ts";
import { moved } from "./notes.ts";
import type { Rect } from "./placement.ts";
import {
	areaOf,
	belongsTo,
	centreOf,
	clearance,
	clearMove,
	framedArea,
	growsApart,
	inside,
	near,
	spacedFrom,
	spacedResize,
	unframed,
} from "./placement.ts";
import { rectOf } from "./regions.ts";
import { standing } from "./spacing.ts";
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

type Home = { region: Rect; frame: Rect };

type Around = { own: Rect[]; others: Rect[]; homes: Home[] };

function projectsAround(key: NodeKey): Around {
	const current = board.peek();
	const id = key.slice(key.indexOf(":") + 1);
	const sessionId = key.startsWith("subagent:")
		? current?.subagents.find((agent) => agent.id === id)?.sessionId
		: id;
	const session = current?.sessions.find((s) => s.id === sessionId);
	if (!session) return { own: [], others: [], homes: [] };
	const mine = (group: Group) =>
		group.region
			? belongsTo(group.region, session.cwd)
			: group.project === session.project;
	const all = groups.peek();
	return {
		own: all
			.filter((group) => mine(group) && !group.region)
			.map((group) => unframed(group.frame)),
		others: all.filter((group) => !mine(group)).map((group) => group.frame),
		homes: all.flatMap((group) =>
			group.region && mine(group)
				? [{ region: rectOf(group.region), frame: group.frame }]
				: [],
		),
	};
}

/** A card joins a region of its own by its centre, or keeps a cell from it. */
function settlesBy(root: Rect, rects: readonly Rect[], homes: readonly Home[]) {
	return homes.every(
		(home) =>
			inside(home.region, centreOf(root)) ||
			rects.every((rect) => !near(rect, home.frame, clearance)),
	);
}

type Carrying = {
	key: NodeKey;
	origin: Point;
	root: Rect;
	load: Load;
	rects: Rect[];
	framed: Rect[];
	area: Rect;
	around: Around;
	standing: Rect[];
	by: Point;
};

let carrying: Carrying | null = null;

type Resizing = { key: NodeKey; last: Rect; fits: (rect: Rect) => boolean };

let resizing: Resizing | null = null;

function startResizing(key: NodeKey): Resizing | null {
	const node = arrangement.peek()?.nodes.get(key);
	if (!node) return null;
	const loose = standing({ nodes: [key] });
	const { others } = projectsAround(key);
	return {
		key,
		last: { x: node.x, y: node.y, w: node.w, h: node.h },
		fits: (rect) =>
			spacedFrom(rect, loose) &&
			others.every((frame) => !near(framedArea(rect), frame, clearance)),
	};
}

/** A card grows only as far as leaves a grid cell around it. */
function resizeCard(gesture: Arranging): void {
	if (gesture.phase === "cancel") {
		resizing = null;
		arrangeNode(gesture);
		return;
	}
	if (resizing?.key !== gesture.key) resizing = startResizing(gesture.key);
	const current = resizing;
	if (!current) {
		arrangeNode(gesture);
		return;
	}
	current.last = spacedResize(gesture.rect, current.last, current.fits);
	if (gesture.phase === "drop") resizing = null;
	arrangeNode({ ...gesture, rect: current.last });
}

function startCarrying(key: NodeKey): Carrying | null {
	const load = loadOf([key]);
	const root = load.nodes.find((passenger) => passenger.key === key);
	if (!root) return null;
	const rects = footprintOf(load);
	return {
		key,
		origin: { x: root.rect.x, y: root.rect.y },
		root: root.rect,
		load,
		rects,
		framed: rects.map(framedArea),
		area: areaOf(rects),
		around: projectsAround(key),
		standing: standing({
			nodes: load.nodes.map((passenger) => passenger.key),
			annotations: load.notes.map((note) => note.id),
		}),
		by: { x: 0, y: 0 },
	};
}

function fitsBy(carried: Carrying, by: Point): boolean {
	const shift = (rect: Rect) => ({
		...rect,
		x: rect.x + by.x,
		y: rect.y + by.y,
	});
	const rects = carried.rects.map(shift);
	return (
		rects.every((rect) => spacedFrom(rect, carried.standing)) &&
		settlesBy(shift(carried.root), rects, carried.around.homes)
	);
}

export function arrangeCard(gesture: Arranging): void {
	if (gesture.mode === "resize") {
		resizeCard(gesture);
		return;
	}
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
	const { area, around } = carried;
	carried.by = clearMove(
		carried.framed,
		around.others,
		{
			x: gesture.rect.x - carried.origin.x,
			y: gesture.rect.y - carried.origin.y,
		},
		carried.by,
		(by) =>
			growsApart(
				{ ...area, x: area.x + by.x, y: area.y + by.y },
				around.own,
				around.others,
			) && fitsBy(carried, by),
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
