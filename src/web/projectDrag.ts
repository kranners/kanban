import type { Annotation, Point } from "../shared/types.ts";
import { current as shownAnnotations } from "./annotations.ts";
import { groups } from "./arrangement.ts";
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
	rectOf,
	resizedClear,
	storableRegion,
} from "./regions.ts";

const dragThreshold = 4;

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
