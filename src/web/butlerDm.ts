import type { ButlerCardState } from "../shared/types.ts";

// Where Butler's DM face sits on screen, when it shows, and how it moves.
// Pure: the page measures the board's cards and its own controls and hands
// them in, so the same inputs always give the same spot.

export type Box = { x: number; y: number; w: number; h: number };
export type Spot = { x: number; y: number };
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const corners: readonly Corner[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
];

/** Where the face lives: docked in a corner, or held at an anchor given as fractions of the viewport. */
export type DmDock =
	| { corner: Corner }
	| { anchor: { fx: number; fy: number } };

/** The face sits at the upper right of the board until Aaron moves it. */
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

/** Where a release leaves the face: docked when near a corner, otherwise held where it was dropped. */
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

/** The face's spot for an anchor: centred on it, held still, never drifting. */
export function anchorSpot(
	anchor: { fx: number; fy: number },
	size: { w: number; h: number },
	viewport: { w: number; h: number },
): Spot {
	const x = anchor.fx * viewport.w - size.w / 2;
	const y = anchor.fy * viewport.h - size.h / 2;
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
	/** Cards and notes on screen, which an undocked face never covers. */
	avoid: readonly Box[];
	/** The page's fixed controls, the top bar, rail, zoom and message button, which no face ever covers. */
	controls: readonly Box[];
	/** What Butler is touching, on screen; the face parks beside it. */
	target: Box | null;
	/** Where the face wants to be otherwise: its corner or its anchor. */
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

/**
 * How the face moves, as the old presence layer did: one quick ease-out
 * snap to each new spot, a single short settle as it appears, and the mood
 * picture swapping with a short fade. Nothing loops, floats or bobs.
 */
export const faceMotion = {
	/** A move to a new spot. */
	moveMs: 200,
	/** The settle as it appears or hides. */
	settleMs: 160,
	/** The mood picture's fade as it swaps. */
	moodFadeMs: 100,
	easing: "ease-out",
} as const;

/** How long the face stays up after Butler's last activity on the board. */
export const faceHoldMs = 4000;

/** When the face shows: only while Butler is active (the default), always, or never. */
export type FaceMode = "active" | "always" | "never";

export type FaceSettings = {
	mode: FaceMode;
	/** Leave out the small dock button the face leaves while hidden. */
	hideButton: boolean;
};

export const defaultFaceSettings: FaceSettings = {
	mode: "active",
	hideButton: false,
};

export const faceSettingsKey = "kanban.butlerFace";

const faceModes: readonly FaceMode[] = ["active", "always", "never"];

/** Stored face settings, anything missing or unknown taking its default. */
export function parseFaceSettings(raw: string | null): FaceSettings {
	if (!raw) return defaultFaceSettings;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		return {
			mode: faceModes.includes(value.mode as FaceMode)
				? (value.mode as FaceMode)
				: defaultFaceSettings.mode,
			hideButton: value.hideButton === true,
		};
	} catch {
		return defaultFaceSettings;
	}
}

/** What the page last saw of Butler, to tell when he does something new. */
export type Activity = {
	/** When he last looked at or acted on something on the board. */
	boardAt: number;
	dmState: ButlerCardState | null;
	dmWaiting: number;
	dmMood: string | null;
};

export function activityOf(presence: {
	looking: { at: number } | null;
	working: { at: number } | null;
	dm?: { state: ButlerCardState; waiting: number; mood?: string };
}): Activity {
	return {
		boardAt: Math.max(presence.looking?.at ?? 0, presence.working?.at ?? 0),
		dmState: presence.dm?.state ?? null,
		dmWaiting: presence.dm?.waiting ?? 0,
		dmMood: presence.dm?.mood ?? null,
	};
}

/**
 * When Butler did something new between two looks, or null when he did
 * not: he looked at or acted on the board, a DM reply arrived (its turn
 * finished or its mood changed), or something new waits on Aaron. On the
 * page's first look only board activity still within the hold counts, so
 * a reload does not pop the face up for old news.
 */
export function newActivity(
	before: Activity | null,
	after: Activity,
	now: number,
): number | null {
	if (!before) {
		return after.boardAt > 0 && now - after.boardAt < faceHoldMs
			? after.boardAt
			: null;
	}
	if (after.boardAt > before.boardAt) return Math.min(now, after.boardAt);
	if (after.dmWaiting > before.dmWaiting) return now;
	if (after.dmState === "needs-you" && before.dmState !== "needs-you") {
		return now;
	}
	if (before.dmState === "working" && after.dmState !== "working") return now;
	if (after.dmMood !== null && after.dmMood !== before.dmMood) return now;
	return null;
}

/** Whether the face is up: always or never by setting, otherwise until the hold after his last activity, or while Aaron holds or points at it. */
export function faceShown(input: {
	mode: FaceMode;
	lastActive: number | null;
	now: number;
	held: boolean;
}): boolean {
	if (input.mode === "always") return true;
	if (input.mode === "never") return false;
	if (input.held) return true;
	return input.lastActive !== null && input.now - input.lastActive < faceHoldMs;
}

/** Whether the small dock button shows: while the face is hidden, unless the setting hides it. */
export function dockButtonShown(
	settings: FaceSettings,
	faceUp: boolean,
): boolean {
	return !settings.hideButton && !faceUp;
}

/** The dock button's size, a small face. */
export const dockButtonSize = 28;

/**
 * Where the dock button sits: the bottom right of the board's area, slid
 * up clear of any control there, the touch screen's message button among
 * them.
 */
export function dockButtonSpot(area: Box, controls: readonly Box[]): Spot {
	const size = dockButtonSize;
	const x = area.x + area.w - size - faceMargin;
	const bottom = area.y + area.h - size - faceMargin;
	const clear = (spot: Spot) =>
		!controls.some((c) => overlaps({ ...spot, w: size, h: size }, c, 4));
	for (let y = bottom; y >= area.y + faceMargin; y -= 8) {
		if (clear({ x, y })) return { x, y };
	}
	return { x, y: bottom };
}

/** The key that opens the DM from anywhere on the board: b, for Butler. */
export function isDmKey(
	press: {
		key: string;
		repeat: boolean;
		altKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
		shiftKey: boolean;
	},
	typing: boolean,
): boolean {
	return (
		press.key.toLowerCase() === "b" &&
		!press.repeat &&
		!press.altKey &&
		!press.ctrlKey &&
		!press.metaKey &&
		!press.shiftKey &&
		!typing
	);
}
