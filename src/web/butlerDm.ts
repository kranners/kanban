import type { ButlerCardState } from "../shared/types.ts";

// Where Butler's DM face sits on screen, and how it moves. Pure: the page
// measures the board's cards and its own controls and hands them in, so the
// same inputs always give the same spot.

export type Box = { x: number; y: number; w: number; h: number };
export type Spot = { x: number; y: number };
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const corners: readonly Corner[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
];

/** Where the face lives: docked in a corner, or drifting round an anchor given as fractions of the viewport. */
export type DmDock =
	| { corner: Corner }
	| { anchor: { fx: number; fy: number } };

/** The face drifts round the upper right of the board until Aaron moves it. */
export const defaultDock: DmDock = { anchor: { fx: 0.78, fy: 0.22 } };

export const dockStorageKey = "kanban.butlerDm.dock";

/** Gap between the face and what it avoids, and the viewport's edge. */
export const faceMargin = 12;
/** How far a press must move before it drags the face. */
export const dragThreshold = 4;
/** How close to a corner a release docks the face there. */
export const dockReach = 120;

/** The ring round the face: grey idle, teal and gold working, amber waiting on Aaron, red failed. */
export type DmRing = "idle" | "working" | "waiting" | "failed";

export function ringOf(state: ButlerCardState, waiting: number): DmRing {
	if (state === "failed") return "failed";
	if (state === "needs-you" || waiting > 0) return "waiting";
	if (state === "working") return "working";
	return "idle";
}

/** A stored dock, or null when it is not one. */
export function parseDock(raw: string | null): DmDock | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (corners.includes(value.corner as Corner)) {
			return { corner: value.corner as Corner };
		}
		const anchor = value.anchor as Record<string, unknown> | undefined;
		const fraction = (n: unknown) =>
			typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
		if (anchor && fraction(anchor.fx) && fraction(anchor.fy)) {
			return { anchor: { fx: anchor.fx as number, fy: anchor.fy as number } };
		}
	} catch {}
	return null;
}

export function pastThreshold(from: Spot, to: Spot): boolean {
	return Math.hypot(to.x - from.x, to.y - from.y) >= dragThreshold;
}

/** The corner a release at `point` docks into, if it is near one. */
export function cornerNear(
	point: Spot,
	viewport: { w: number; h: number },
): Corner | null {
	const left = point.x <= dockReach;
	const right = point.x >= viewport.w - dockReach;
	const top = point.y <= dockReach;
	const bottom = point.y >= viewport.h - dockReach;
	if (top && left) return "top-left";
	if (top && right) return "top-right";
	if (bottom && left) return "bottom-left";
	if (bottom && right) return "bottom-right";
	return null;
}

/** Where a release leaves the face: docked when near a corner, otherwise drifting round where it was dropped. */
export function dockAt(
	spot: Spot,
	size: { w: number; h: number },
	viewport: { w: number; h: number },
): DmDock {
	const centre = { x: spot.x + size.w / 2, y: spot.y + size.h / 2 };
	const corner = cornerNear(centre, viewport);
	if (corner) return { corner };
	const clamp = (n: number) => Math.min(1, Math.max(0, n));
	return {
		anchor: {
			fx: clamp(centre.x / Math.max(1, viewport.w)),
			fy: clamp(centre.y / Math.max(1, viewport.h)),
		},
	};
}

const overlaps = (a: Box, b: Box, margin: number) =>
	a.x < b.x + b.w + margin &&
	b.x < a.x + a.w + margin &&
	a.y < b.y + b.h + margin &&
	b.y < a.y + a.h + margin;

const inside = (box: Box, viewport: { w: number; h: number }) =>
	box.x >= faceMargin &&
	box.y >= faceMargin &&
	box.x + box.w <= viewport.w - faceMargin &&
	box.y + box.h <= viewport.h - faceMargin;

const clampInto = (
	spot: Spot,
	size: { w: number; h: number },
	viewport: { w: number; h: number },
): Spot => ({
	x: Math.min(
		Math.max(faceMargin, spot.x),
		Math.max(faceMargin, viewport.w - size.w - faceMargin),
	),
	y: Math.min(
		Math.max(faceMargin, spot.y),
		Math.max(faceMargin, viewport.h - size.h - faceMargin),
	),
});

/** How far the face wanders from its anchor, and how slowly: one lap takes minutes. */
const driftReach = 140;
const driftPeriodX = 97_000;
const driftPeriodY = 131_000;

/** The spot the face drifts towards at time `t`: a slow loop round its anchor. */
export function driftSpot(
	anchor: { fx: number; fy: number },
	t: number,
	size: { w: number; h: number },
	viewport: { w: number; h: number },
	still = false,
): Spot {
	const centre = { x: anchor.fx * viewport.w, y: anchor.fy * viewport.h };
	const reachX = still ? 0 : Math.min(driftReach, viewport.w / 6);
	const reachY = still ? 0 : Math.min(driftReach * 0.6, viewport.h / 6);
	const x =
		centre.x + reachX * Math.sin((2 * Math.PI * t) / driftPeriodX) - size.w / 2;
	const y =
		centre.y + reachY * Math.sin((2 * Math.PI * t) / driftPeriodY) - size.h / 2;
	return clampInto({ x, y }, size, viewport);
}

/** The corner's own spot, inside the margin. */
export function cornerSpot(
	corner: Corner,
	size: { w: number; h: number },
	viewport: { w: number; h: number },
): Spot {
	const x = corner.endsWith("left")
		? faceMargin
		: viewport.w - size.w - faceMargin;
	const y = corner.startsWith("top")
		? faceMargin
		: viewport.h - size.h - faceMargin;
	return clampInto({ x, y }, size, viewport);
}

/** Spots right beside a box, on each side and corner, the right side first. */
function besideSpots(target: Box, size: { w: number; h: number }): Spot[] {
	const gap = faceMargin;
	const midY = target.y + target.h / 2 - size.h / 2;
	const midX = target.x + target.w / 2 - size.w / 2;
	return [
		{ x: target.x + target.w + gap, y: midY },
		{ x: target.x - size.w - gap, y: midY },
		{ x: midX, y: target.y + target.h + gap },
		{ x: midX, y: target.y - size.h - gap },
		{ x: target.x + target.w + gap, y: target.y - size.h - gap },
		{ x: target.x + target.w + gap, y: target.y + target.h + gap },
		{ x: target.x - size.w - gap, y: target.y - size.h - gap },
		{ x: target.x - size.w - gap, y: target.y + target.h + gap },
	];
}

/** Clear spots on rings round `from`, nearest first, so a blocked face moves as little as it can. */
function* searchRound(from: Spot, step: number, rings: number) {
	yield from;
	for (let ring = 1; ring <= rings; ring += 1) {
		const r = ring * step;
		const points = Math.max(8, ring * 8);
		for (let i = 0; i < points; i += 1) {
			const angle = (2 * Math.PI * i) / points;
			yield {
				x: from.x + r * Math.cos(angle),
				y: from.y + r * Math.sin(angle),
			};
		}
	}
}

export type PlaceInput = {
	size: { w: number; h: number };
	viewport: { w: number; h: number };
	/** Cards and notes on screen, which a drifting face never covers. */
	avoid: readonly Box[];
	/** The page's fixed controls, the top bar, rail, zoom and message button, which no face ever covers. */
	controls: readonly Box[];
	/** What Butler is touching, on screen; the face parks beside it. */
	target: Box | null;
	/** Where the face wants to be otherwise: its corner or its drift spot. */
	wanted: Spot;
	/** A docked face stays in its corner, whatever it covers. */
	docked: boolean;
};

/**
 * Where the face goes: in its corner when docked; beside what Butler is
 * touching when that leaves a clear spot; otherwise the clear spot nearest
 * where it wants to be. Never outside the viewport.
 */
export function placeFace(input: PlaceInput): Spot {
	const { size, viewport, controls } = input;
	const clearOf = (spot: Spot, boxes: readonly Box[]) => {
		const box = { ...spot, ...size };
		return !boxes.some((a) => overlaps(box, a, 4));
	};
	const avoid = [...input.avoid, ...controls];
	const fits = (spot: Spot) =>
		inside({ ...spot, ...size }, viewport) && clearOf(spot, avoid);
	if (input.docked) {
		// Docked, it keeps its corner, sliding along the edge only off a control.
		const corner = clampInto(input.wanted, size, viewport);
		const down = corner.y < viewport.h / 2 ? 1 : -1;
		for (let dy = 0; dy < viewport.h; dy += 8) {
			const spot = { x: corner.x, y: corner.y + down * dy };
			if (!inside({ ...spot, ...size }, viewport)) break;
			if (clearOf(spot, controls)) return spot;
		}
		return corner;
	}
	if (input.target) {
		const beside = besideSpots(input.target, size).find(fits);
		if (beside) return beside;
	}
	for (const spot of searchRound(input.wanted, 32, 12)) {
		if (fits(spot)) return spot;
	}
	return clampInto(input.wanted, size, viewport);
}

/** Whether the face's status sits to its left: in the right half of the screen, so the face leads towards the edge. */
export function labelOnLeft(
	spot: Spot,
	size: { w: number },
	viewport: { w: number },
): boolean {
	return spot.x + size.w / 2 > viewport.w / 2;
}
