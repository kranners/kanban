import type { Point, Region, Session } from "../shared/types.ts";
import type { KeyPress } from "./actions.ts";
import { directoryName } from "./focus/paths.ts";
import { gridSize, snap, snapPoint } from "./grid.ts";
import type { Group } from "./groups.ts";
import { groupLabelSpace, groupPadding } from "./groups.ts";
import type { NodeKey, PlacedNode } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import { boundsOf, near, nearestFree, sessionSize } from "./placement.ts";

export type RegionHandle =
	| "move"
	| "n"
	| "s"
	| "e"
	| "w"
	| "ne"
	| "nw"
	| "se"
	| "sw";

export const regionEdges: readonly Exclude<RegionHandle, "move">[] = [
	"n",
	"s",
	"e",
	"w",
	"ne",
	"nw",
	"se",
	"sw",
];

export const minRegionSize = { w: 10 * gridSize, h: 6 * gridSize };
export const maxRegionSize = { w: 800 * gridSize, h: 800 * gridSize };
export const newRegionSize = { w: 20 * gridSize, h: 14 * gridSize };

export function isRegionKey(press: KeyPress, typing: boolean): boolean {
	return (
		press.key.toLowerCase() === "r" &&
		!press.repeat &&
		!press.altKey &&
		!press.ctrlKey &&
		!press.metaKey &&
		!press.shiftKey &&
		!typing
	);
}

export function regionTitle(region: Pick<Region, "name" | "cwd">): string {
	return region.name ?? (directoryName(region.cwd) || region.cwd);
}

export function newRegionAt(point: Point): Rect {
	return { ...snapPoint(point), ...newRegionSize };
}

export function rectOf(region: Region): Rect {
	return { x: region.x, y: region.y, w: region.w, h: region.h };
}

export function arrangedRegion(
	origin: Rect,
	handle: RegionHandle,
	dx: number,
	dy: number,
): Rect {
	if (handle === "move")
		return { ...origin, x: snap(origin.x + dx), y: snap(origin.y + dy) };
	let left = origin.x;
	let top = origin.y;
	let right = origin.x + origin.w;
	let bottom = origin.y + origin.h;
	if (handle.includes("w"))
		left = Math.max(
			right - maxRegionSize.w,
			Math.min(snap(left + dx), right - minRegionSize.w),
		);
	if (handle.includes("e"))
		right = Math.min(
			left + maxRegionSize.w,
			Math.max(snap(right + dx), left + minRegionSize.w),
		);
	if (handle.includes("n"))
		top = Math.max(
			bottom - maxRegionSize.h,
			Math.min(snap(top + dy), bottom - minRegionSize.h),
		);
	if (handle.includes("s"))
		bottom = Math.min(
			top + maxRegionSize.h,
			Math.max(snap(bottom + dy), top + minRegionSize.h),
		);
	return { x: left, y: top, w: right - left, h: bottom - top };
}

export function storableRegion(rect: Rect): Rect {
	return {
		x: snap(rect.x),
		y: snap(rect.y),
		w: Math.min(maxRegionSize.w, Math.max(minRegionSize.w, snap(rect.w))),
		h: Math.min(maxRegionSize.h, Math.max(minRegionSize.h, snap(rect.h))),
	};
}

export function belongsTo(region: Pick<Region, "cwd">, cwd: string): boolean {
	const root = region.cwd.replace(/\/+$/, "");
	return cwd === region.cwd || cwd.startsWith(`${root}/`);
}

function centreOf(rect: Rect): Point {
	return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function inside(rect: Rect, point: Point): boolean {
	return (
		point.x > rect.x &&
		point.x < rect.x + rect.w &&
		point.y > rect.y &&
		point.y < rect.y + rect.h
	);
}

function area(rect: Rect): number {
	return rect.w * rect.h;
}

function footprintOf(
	key: NodeKey,
	nodes: ReadonlyMap<NodeKey, PlacedNode>,
): Rect[] {
	return [...nodes.values()].filter(
		(node) => node.key === key || node.follows === key,
	);
}

function framed(region: Region, members: Rect[]): Rect {
	if (members.length === 0) return rectOf(region);
	const held = boundsOf(members);
	const padded = {
		x: held.x - groupPadding,
		y: held.y - groupLabelSpace,
		w: held.width + groupPadding * 2,
		h: held.height + groupPadding + groupLabelSpace,
	};
	const all = boundsOf([rectOf(region), padded]);
	return { x: all.x, y: all.y, w: all.width, h: all.height };
}

export function regionGroups(
	regions: readonly Region[],
	derived: readonly Group[],
	sessions: readonly Session[],
	nodes: ReadonlyMap<NodeKey, PlacedNode>,
): Group[] {
	const owner = new Map<NodeKey, Region>();
	for (const session of sessions) {
		const key = nodeKey({ kind: "session", id: session.id });
		const node = nodes.get(key);
		if (!node) continue;
		const centre = centreOf(node);
		const home = regions
			.filter(
				(region) =>
					belongsTo(region, session.cwd) && inside(rectOf(region), centre),
			)
			.reduce<Region | null>(
				(best, region) =>
					best === null || area(region) < area(best) ? region : best,
				null,
			);
		if (home) owner.set(key, home);
	}

	const adopted = derived.filter((group) => {
		const home = group.members
			.map((key) => owner.get(key))
			.find((region) => region !== undefined);
		if (!home) return false;
		for (const key of group.members) if (!owner.has(key)) owner.set(key, home);
		return true;
	});

	const updated = new Map(sessions.map((s) => [s.id, s.updatedAt]));
	const recency = (key: NodeKey) =>
		updated.get(key.slice(key.indexOf(":") + 1)) ?? 0;
	const framedRegions = regions.map((region): Group => {
		const members = [...owner]
			.filter(([, home]) => home === region)
			.map(([key]) => key)
			.sort((a, b) => recency(b) - recency(a) || a.localeCompare(b));
		return {
			key: `region:${region.id}`,
			project: regionTitle(region),
			cwd: region.cwd,
			members,
			frame: framed(
				region,
				members.flatMap((key) => footprintOf(key, nodes)),
			),
			region,
		};
	});
	return [
		...framedRegions,
		...derived.filter((group) => !adopted.includes(group)),
	];
}

export function spotInRegion(
	point: Point,
	region: Rect,
	taken: readonly Rect[],
): Point | null {
	const card = (at: Point): Rect => ({ ...at, ...sessionSize });
	const start = snapPoint({
		x: Math.min(
			Math.max(point.x, region.x),
			region.x + region.w - sessionSize.w / 2 - gridSize,
		),
		y: Math.min(
			Math.max(point.y, region.y),
			region.y + region.h - sessionSize.h / 2 - gridSize,
		),
	});
	return nearestFree(
		start,
		(at) =>
			inside(region, centreOf(card(at))) &&
			taken.every((r) => !near(card(at), r, gridSize)),
	);
}
