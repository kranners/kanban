import { batch, effect } from "@preact/signals";
import type { Annotation, Point } from "../shared/types.ts";
import { current as shownAnnotations } from "./annotations.ts";
import { groups, savedPlacement } from "./arrangement.ts";
import { view } from "./Canvas.tsx";
import type { Load } from "./carrying.ts";
import {
	cancelLoad,
	commitLoad,
	footprintOf,
	loadOf,
	previewLoad,
} from "./carrying.ts";
import { snap } from "./grid.ts";
import type { Group } from "./groups.ts";
import type { Rect } from "./placement.ts";
import { clearMove } from "./placement.ts";
import { cancelRegion, commitRegion, previewRegion } from "./regionState.ts";
import type { RegionHandle } from "./regions.ts";
import {
	arrangedRegion,
	centredIn,
	pushedApart,
	rectOf,
	resizedClear,
	storableRegion,
} from "./regions.ts";
import { quickPrompt } from "./spawns.ts";

const dragThreshold = 4;
const settleMs = 600;

type Drag = {
	pointerId: number;
	project: Group;
	handle: RegionHandle;
	origin: Rect;
	others: Rect[];
	start: Point;
	rect: Rect;
	by: Point;
	load: Load;
	moving: Rect[];
	moved: boolean;
};

let drag: Drag | null = null;
let dragged = false;

export function justDragged(): boolean {
	return dragged;
}

function setArranging(on: boolean): void {
	document.querySelector(".viewport")?.classList.toggle("arranging", on);
}

function follow(on: boolean): void {
	const toggle = on ? addEventListener : removeEventListener;
	toggle("pointermove", continueDrag);
	toggle("pointerup", endDrag);
	toggle("pointercancel", endDrag);
}

function notesOf(project: Group): Annotation[] {
	const all = Object.values(shownAnnotations.peek());
	const inside = new Set(centredIn(project.frame, all));
	return all.filter(
		(a) =>
			inside.has(a) ||
			(a.kind === "note" &&
				a.region !== undefined &&
				a.region === project.region?.id),
	);
}

function beginDrag(
	event: PointerEvent,
	project: Group,
	handle: RegionHandle,
): void {
	if (event.button !== 0 || drag) return;
	if (handle !== "move" && !project.region) return;
	(event.currentTarget as Element).setPointerCapture(event.pointerId);
	const origin = project.region ? rectOf(project.region) : project.frame;
	const load =
		handle === "move"
			? loadOf(project.members, notesOf(project))
			: { nodes: [], notes: [] };
	drag = {
		pointerId: event.pointerId,
		project,
		handle,
		origin,
		others: groups
			.peek()
			.filter((other) => other.key !== project.key)
			.map((other) => other.frame),
		start: { x: event.clientX, y: event.clientY },
		rect: origin,
		by: { x: 0, y: 0 },
		load,
		moving: [project.frame, ...footprintOf(load)],
		moved: false,
	};
	follow(true);
}

function movedBy(current: Drag, dx: number, dy: number): Point {
	const wanted = current.project.region
		? arrangedRegion(current.origin, "move", dx, dy)
		: { x: current.origin.x + snap(dx), y: current.origin.y + snap(dy) };
	return clearMove(
		current.moving,
		current.others,
		{ x: wanted.x - current.origin.x, y: wanted.y - current.origin.y },
		current.by,
	);
}

function continueDrag(event: PointerEvent): void {
	if (!drag || event.pointerId !== drag.pointerId) return;
	const dx = event.clientX - drag.start.x;
	const dy = event.clientY - drag.start.y;
	if (!drag.moved && Math.hypot(dx, dy) < dragThreshold) return;
	drag.moved = true;
	setArranging(true);
	const { k } = view.peek();
	if (drag.handle === "move") {
		drag.by = movedBy(drag, dx / k, dy / k);
		drag.rect = {
			...drag.origin,
			x: drag.origin.x + drag.by.x,
			y: drag.origin.y + drag.by.y,
		};
		previewLoad(drag.load, drag.by);
	} else {
		drag.rect = resizedClear(
			drag.origin,
			arrangedRegion(drag.origin, drag.handle, dx / k, dy / k),
			drag.handle,
			drag.others,
		);
	}
	if (drag.project.region) previewRegion(drag.project.region.id, drag.rect);
}

function endDrag(event: PointerEvent): void {
	if (!drag || event.pointerId !== drag.pointerId) return;
	const ended = drag;
	drag = null;
	follow(false);
	if (!ended.moved) return;
	setArranging(false);
	dragged = true;
	setTimeout(() => {
		dragged = false;
	}, 0);
	const region = ended.project.region;
	if (event.type === "pointercancel") {
		if (region) cancelRegion(region.id);
		cancelLoad(ended.load);
		return;
	}
	if (region) void commitRegion(region.id, storableRegion(ended.rect));
	commitLoad(ended.load, ended.by);
}

export function projectGestures(project: Group, handle: RegionHandle) {
	return {
		"data-no-pan": true,
		onPointerDown: (event: PointerEvent) => beginDrag(event, project, handle),
	};
}

let settling: ReturnType<typeof setTimeout> | undefined;

function arranging(): boolean {
	return (
		drag !== null ||
		quickPrompt.peek() !== null ||
		document.querySelector(".viewport.arranging") !== null
	);
}

function makeRoom(): void {
	settling = undefined;
	if (arranging()) {
		settling = setTimeout(makeRoom, settleMs);
		return;
	}
	const projects = groups.peek();
	const pushes = pushedApart(projects);
	const movedNodes = new Set<string>();
	const movedNotes = new Set<string>();
	batch(() => {
		for (const project of projects) {
			const by = pushes.get(project.key);
			if (!by) continue;
			const load = loadOf(project.members, notesOf(project));
			const unmoved = {
				nodes: load.nodes
					.filter((passenger) => !movedNodes.has(passenger.key))
					.map((passenger) => ({
						...passenger,
						pinned: savedPlacement(passenger.key)?.pinned === true,
					})),
				notes: load.notes.filter((note) => !movedNotes.has(note.id)),
			};
			for (const passenger of unmoved.nodes) movedNodes.add(passenger.key);
			for (const note of unmoved.notes) movedNotes.add(note.id);
			const region = project.region;
			if (region)
				void commitRegion(
					region.id,
					storableRegion({
						...rectOf(region),
						x: region.x + by.x,
						y: region.y + by.y,
					}),
				);
			commitLoad(unmoved, by);
		}
	});
}

effect(() => {
	if (pushedApart(groups.value).size === 0) {
		clearTimeout(settling);
		settling = undefined;
	} else if (settling === undefined) settling = setTimeout(makeRoom, settleMs);
});
