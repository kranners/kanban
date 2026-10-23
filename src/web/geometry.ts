import type { PlacedNode } from "./layout.ts";
import { sessionLabelHeight } from "./layout.ts";

export type Point = { x: number; y: number };

function entryY(node: PlacedNode): number {
	return node.ref.kind === "session" ? node.y + sessionLabelHeight - 1 : node.y;
}

export function treePath(from: PlacedNode, to: PlacedNode): string {
	const x1 = from.x + from.w / 2;
	const y1 = from.y + from.h;
	const x2 = to.x + to.w / 2;
	const y2 = entryY(to);
	const mid = (y1 + y2) / 2;
	return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

export function treeMidpoint(from: PlacedNode, to: PlacedNode): Point {
	return {
		x: (from.x + from.w / 2 + to.x + to.w / 2) / 2,
		y: (from.y + from.h + entryY(to)) / 2,
	};
}

function frameCentre(node: PlacedNode): Point {
	const top =
		node.ref.kind === "session" ? node.y + sessionLabelHeight : node.y;
	return { x: node.x + node.w / 2, y: (top + node.y + node.h) / 2 };
}

export type Arc = { path: string; mid: Point };

export function messageArc(from: PlacedNode, to: PlacedNode): Arc {
	const a = frameCentre(from);
	const b = frameCentre(to);
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy) || 1;
	const bend = Math.max(48, length * 0.22);
	const control = {
		x: (a.x + b.x) / 2 + (dy / length) * bend,
		y: (a.y + b.y) / 2 - (dx / length) * bend,
	};
	return {
		path: `M${a.x} ${a.y} Q${control.x} ${control.y} ${b.x} ${b.y}`,
		mid: {
			x: 0.25 * a.x + 0.5 * control.x + 0.25 * b.x,
			y: 0.25 * a.y + 0.5 * control.y + 0.25 * b.y,
		},
	};
}
