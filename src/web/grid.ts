import type { Point } from "../shared/types.ts";

export const gridSize = 24;

export function snap(value: number): number {
	return Math.round(value / gridSize) * gridSize || 0;
}

export function snapPoint(point: Point): Point {
	return { x: snap(point.x), y: snap(point.y) };
}

export function snapWithin(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, snap(value)));
}

export type DotGrid = { spacing: number; x: number; y: number; fade: number };

const legibleSpacing = 14;
const vanishingSpacing = 6;

export function dotGrid(view: { x: number; y: number; k: number }): DotGrid {
	const spacing = gridSize * view.k;
	const fade = Math.min(
		1,
		Math.max(
			0,
			(spacing - vanishingSpacing) / (legibleSpacing - vanishingSpacing),
		),
	);
	const offset = (origin: number) =>
		(((origin - spacing / 2) % spacing) + spacing) % spacing;
	return { spacing, x: offset(view.x), y: offset(view.y), fade };
}
