import type { Link } from "../shared/types.ts";
import type { NodeKey, PlacedNode } from "./layout.ts";
import { nodeKey } from "./layout.ts";

export type Point = { x: number; y: number };

const labelInset = 12;

function entryPoint(node: PlacedNode): Point {
	return node.ref.kind === "session"
		? { x: node.x + labelInset, y: node.y }
		: { x: node.x + node.w / 2, y: node.y };
}

function exitPoint(node: PlacedNode): Point {
	return { x: node.x + node.w / 2, y: node.y + node.h };
}

export function treePath(from: PlacedNode, to: PlacedNode): string {
	const a = exitPoint(from);
	const b = entryPoint(to);
	const mid = (a.y + b.y) / 2;
	return `M${a.x} ${a.y} C${a.x} ${mid} ${b.x} ${mid} ${b.x} ${b.y}`;
}

export function treeMidpoint(from: PlacedNode, to: PlacedNode): Point {
	const a = exitPoint(from);
	const b = entryPoint(to);
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

type Frame = { centre: Point; halfWidth: number; halfHeight: number };

function frameOf(node: PlacedNode): Frame {
	const top = node.y;
	return {
		centre: { x: node.x + node.w / 2, y: (top + node.y + node.h) / 2 },
		halfWidth: node.w / 2,
		halfHeight: (node.y + node.h - top) / 2,
	};
}

function frameEdgeToward(frame: Frame, target: Point): Point {
	const dx = target.x - frame.centre.x;
	const dy = target.y - frame.centre.y;
	const scale = Math.min(
		dx === 0 ? Number.POSITIVE_INFINITY : frame.halfWidth / Math.abs(dx),
		dy === 0 ? Number.POSITIVE_INFINITY : frame.halfHeight / Math.abs(dy),
		1,
	);
	return { x: frame.centre.x + dx * scale, y: frame.centre.y + dy * scale };
}

export type Rect = { x: number; y: number; w: number; h: number };

function rectFrame(rect: Rect): Frame {
	return {
		centre: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
		halfWidth: rect.w / 2,
		halfHeight: rect.h / 2,
	};
}

function overlapping(a: Frame, b: Frame): boolean {
	return (
		Math.abs(a.centre.x - b.centre.x) < a.halfWidth + b.halfWidth &&
		Math.abs(a.centre.y - b.centre.y) < a.halfHeight + b.halfHeight
	);
}

export type Tether = { from: Point; to: Point };

function tether(source: Frame, target: Frame): Tether | null {
	if (overlapping(source, target)) return null;
	return {
		from: frameEdgeToward(source, target.centre),
		to: frameEdgeToward(target, source.centre),
	};
}

export function tetherLine(note: Rect, node: PlacedNode): Tether | null {
	return tether(rectFrame(note), frameOf(node));
}

export function regionTetherLine(note: Rect, region: Rect): Tether | null {
	return tether(rectFrame(note), rectFrame(region));
}

export type Arc = { path: string; mid: Point };

export function messageArc(from: PlacedNode, to: PlacedNode): Arc {
	const source = frameOf(from);
	const target = frameOf(to);
	const dx = target.centre.x - source.centre.x;
	const dy = target.centre.y - source.centre.y;
	const length = Math.hypot(dx, dy) || 1;
	const bend = Math.max(48, length * 0.22);
	const control = {
		x: (source.centre.x + target.centre.x) / 2 + (dy / length) * bend,
		y: (source.centre.y + target.centre.y) / 2 - (dx / length) * bend,
	};
	const a = frameEdgeToward(source, control);
	const b = frameEdgeToward(target, control);
	return {
		path: `M${a.x} ${a.y} Q${control.x} ${control.y} ${b.x} ${b.y}`,
		mid: {
			x: 0.25 * a.x + 0.5 * control.x + 0.25 * b.x,
			y: 0.25 * a.y + 0.5 * control.y + 0.25 * b.y,
		},
	};
}

export type DrawnLink = {
	link: Link;
	from: PlacedNode;
	to: PlacedNode;
	index: number;
};

export function drawnLinks(
	links: readonly Link[],
	nodes: ReadonlyMap<NodeKey, PlacedNode>,
): DrawnLink[] {
	const resolved = links.flatMap((link, index) => {
		const from = nodes.get(nodeKey(link.from));
		const to = nodes.get(nodeKey(link.to));
		return from && to ? [{ link, from, to, index }] : [];
	});
	const firstFollowerRow = new Map<NodeKey, number>();
	for (const { from, to } of resolved) {
		if (!to.follows) continue;
		const top = firstFollowerRow.get(from.key) ?? to.y;
		firstFollowerRow.set(from.key, Math.min(top, to.y));
	}
	return resolved.filter(
		({ from, to }) =>
			!to.follows || to.y <= (firstFollowerRow.get(from.key) ?? to.y),
	);
}

export type Side = "top" | "right" | "bottom" | "left";

export const sides: readonly Side[] = ["top", "right", "bottom", "left"];

const normals: Record<Side, Point> = {
	top: { x: 0, y: -1 },
	right: { x: 1, y: 0 },
	bottom: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
};

export function sidePoint(rect: Rect, side: Side): Point {
	switch (side) {
		case "top":
			return { x: rect.x + rect.w / 2, y: rect.y };
		case "right":
			return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
		case "bottom":
			return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
		case "left":
			return { x: rect.x, y: rect.y + rect.h / 2 };
	}
}

function centreOf(rect: Rect): Point {
	return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function facingSides(a: Rect, b: Rect): [Side, Side] {
	const from = centreOf(a);
	const to = centreOf(b);
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? ["right", "left"] : ["left", "right"];
	}
	return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export function facingSide(rect: Rect, toward: Point): Side {
	const [side] = facingSides(rect, { ...toward, w: 0, h: 0 });
	return side;
}

function pull(point: Point, side: Side, by: number): Point {
	const normal = normals[side];
	return { x: point.x + normal.x * by, y: point.y + normal.y * by };
}

function bezierAt(p: readonly Point[], t: number): Point {
	const u = 1 - t;
	const [a, b, c, d] = p as [Point, Point, Point, Point];
	return {
		x:
			u * u * u * a.x +
			3 * u * u * t * b.x +
			3 * u * t * t * c.x +
			t * t * t * d.x,
		y:
			u * u * u * a.y +
			3 * u * u * t * b.y +
			3 * u * t * t * c.y +
			t * t * t * d.y,
	};
}

function curve(from: Point, fromSide: Side, to: Point, toSide: Side | null) {
	const reach = Math.min(
		160,
		Math.max(40, Math.hypot(to.x - from.x, to.y - from.y) / 3),
	);
	const points = [
		from,
		pull(from, fromSide, reach),
		toSide ? pull(to, toSide, reach) : to,
		to,
	];
	const [, c1, c2] = points as [Point, Point, Point, Point];
	return {
		path: `M${from.x} ${from.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`,
		mid: bezierAt(points, 0.5),
	};
}

export type RelationPath = { path: string; mid: Point; from: Point; to: Point };

export function relationPath(a: Rect, b: Rect): RelationPath {
	const [fromSide, toSide] = facingSides(a, b);
	const from = sidePoint(a, fromSide);
	const to = sidePoint(b, toSide);
	return { ...curve(from, fromSide, to, toSide), from, to };
}

export function previewPath(start: Point, side: Side, to: Point): string {
	return curve(start, side, to, null).path;
}
