import type { Point } from "../shared/types.ts";

export type View = { x: number; y: number; k: number };

export function toBoard(view: View, screen: Point): Point {
	return { x: (screen.x - view.x) / view.k, y: (screen.y - view.y) / view.k };
}

export function toScreen(view: View, board: Point): Point {
	return { x: board.x * view.k + view.x, y: board.y * view.k + view.y };
}

export function fromOrigin(view: View, origin: Point): View {
	return {
		k: view.k,
		x: view.x - origin.x * view.k,
		y: view.y - origin.y * view.k,
	};
}

export const minZoom = 0.15;
export const maxZoom = 2;

export function clampZoom(k: number): number {
	return Math.min(maxZoom, Math.max(minZoom, k));
}

export function zoomAround(
	view: View,
	k: number,
	px: number,
	py: number,
): View {
	const next = clampZoom(k);
	const ratio = next / view.k;
	return {
		k: next,
		x: px - (px - view.x) * ratio,
		y: py - (py - view.y) * ratio,
	};
}

export type Size = { width: number; height: number };

export const fitPadding = 48;
export const legibleZoom = 0.7;

export function availableSize(box: Size, padding = fitPadding): Size {
	return {
		width: Math.max(1, box.width - padding * 2),
		height: Math.max(1, box.height - padding * 2),
	};
}

export type Span = { x: number; w: number };

export function initialView(content: Size, box: Size, anchor?: Span): View {
	const whole = fitView(content, box);
	if (whole.k >= legibleZoom) return whole;
	const available = availableSize(box);
	const k = clampZoom(
		Math.max(
			legibleZoom,
			Math.min(1, available.width / Math.max(1, content.width)),
		),
	);
	const fitsAcross = content.width * k <= available.width;
	if (fitsAcross) {
		return { k, x: (box.width - content.width * k) / 2, y: fitPadding };
	}
	const centred = anchor
		? box.width / 2 - (anchor.x + anchor.w / 2) * k
		: fitPadding;
	const leftmost = box.width - fitPadding - content.width * k;
	return {
		k,
		x: Math.min(fitPadding, Math.max(leftmost, centred)),
		y: fitPadding,
	};
}

export function fitView(content: Size, box: Size, padding = fitPadding): View {
	const k = clampZoom(fitZoom(content, availableSize(box, padding)));
	return {
		k,
		x: (box.width - content.width * k) / 2,
		y: Math.max(padding, (box.height - content.height * k) / 2),
	};
}

export function fitZoom(content: Size, available: Size): number {
	return Math.min(
		1,
		available.width / Math.max(1, content.width),
		available.height / Math.max(1, content.height),
	);
}

export function centredOn(
	rect: Point & { w: number; h: number },
	box: Size,
	k: number,
): View {
	const zoom = clampZoom(Math.max(k, legibleZoom));
	return {
		k: zoom,
		x: box.width / 2 - (rect.x + rect.w / 2) * zoom,
		y: box.height / 2 - (rect.y + rect.h / 2) * zoom,
	};
}
