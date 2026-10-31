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

type Rect = { x: number; y: number; w: number; h: number };

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
