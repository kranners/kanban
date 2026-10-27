import type { Point } from "../shared/types.ts";
import { current as shownAnnotations } from "./annotations.ts";
import { groups } from "./arrangement.ts";
import { view } from "./Canvas.tsx";
import type { Load } from "./carrying.ts";
import { cancelLoad, commitLoad, loadOf, previewLoad } from "./carrying.ts";
import { snap } from "./grid.ts";
import type { Group } from "./groups.ts";
import type { Rect } from "./placement.ts";
import { clearShift } from "./placement.ts";
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

function beginDrag(
	event: PointerEvent,
	project: Group,
	handle: RegionHandle,
): void {
	if (event.button !== 0) return;
	if (handle !== "move" && !project.region) return;
	(event.currentTarget as Element).setPointerCapture(event.pointerId);
	const origin = project.region ? rectOf(project.region) : project.frame;
	const moving = handle === "move";
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
		load: moving
			? loadOf(
					project.members,
					centredIn(project.frame, Object.values(shownAnnotations.peek())),
				)
			: { nodes: [], notes: [] },
		moved: false,
	};
}

function movedBy(current: Drag, dx: number, dy: number): Point {
	const wanted = current.project.region
		? arrangedRegion(current.origin, "move", dx, dy)
		: { x: current.origin.x + snap(dx), y: current.origin.y + snap(dy) };
	return clearShift([current.project.frame], current.others, {
		x: wanted.x - current.origin.x,
		y: wanted.y - current.origin.y,
	});
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
		onPointerMove: continueDrag,
		onPointerUp: endDrag,
		onPointerCancel: endDrag,
	};
}
