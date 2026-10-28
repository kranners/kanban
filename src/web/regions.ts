import type { Point, Region, Session } from "../shared/types.ts";
import type { KeyPress } from "./actions.ts";
import { directoryName } from "./focus/paths.ts";
import { gridSize, snap, snapPoint } from "./grid.ts";
import type { Group } from "./groups.ts";
import type { NodeKey, PlacedNode } from "./layout.ts";
import { nodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import {
	areaOf,
	belongsTo,
	boundsOf,
	centreOf,
	clearSpot,
	framedArea,
	housedBy,
	inside,
	near,
	nearestFree,
	sessionSize,
} from "./placement.ts";

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

function floorToGrid(value: number): number {
	return Math.floor(value / gridSize) * gridSize;
}

function ceilToGrid(value: number): number {
	return Math.ceil(value / gridSize) * gridSize;
}

function edgesOf(rect: Rect) {
	return {
		left: rect.x,
		top: rect.y,
		right: rect.x + rect.w,
		bottom: rect.y + rect.h,
	};
}

function fromEdges(edges: ReturnType<typeof edgesOf>): Rect {
	const { left, top, right, bottom } = edges;
	return { x: left, y: top, w: right - left, h: bottom - top };
}

function stoppedShort(
	origin: Rect,
	rect: Rect,
	handle: RegionHandle,
	other: Rect,
): Rect[] {
	const from = edgesOf(origin);
	const to = edgesOf(rect);
	const beside = edgesOf(other);
	const stops: Rect[] = [];
	if (handle.includes("e") && beside.left >= from.right)
		stops.push(
			fromEdges({
				...to,
				right: Math.max(from.right, floorToGrid(beside.left - gridSize)),
			}),
		);
	if (handle.includes("w") && beside.right <= from.left)
		stops.push(
			fromEdges({
				...to,
				left: Math.min(from.left, ceilToGrid(beside.right + gridSize)),
			}),
		);
	if (handle.includes("s") && beside.top >= from.bottom)
		stops.push(
			fromEdges({
				...to,
				bottom: Math.max(from.bottom, floorToGrid(beside.top - gridSize)),
			}),
		);
	if (handle.includes("n") && beside.bottom <= from.top)
		stops.push(
			fromEdges({
				...to,
				top: Math.min(from.top, ceilToGrid(beside.bottom + gridSize)),
			}),
		);
	return stops;
}

export function resizedClear(
	origin: Rect,
	rect: Rect,
	handle: RegionHandle,
	others: readonly Rect[],
): Rect {
	return others
		.filter((other) => !near(origin, other, 0))
		.reduce((resized, other) => {
			if (!near(resized, other, gridSize)) return resized;
			return stoppedShort(origin, resized, handle, other).reduce<Rect>(
				(best, stop) => (area(stop) > area(best) ? stop : best),
				origin,
			);
		}, rect);
}

export function clearOfProjects<T extends Rect>(
	rect: T,
	frames: readonly Rect[],
): T {
	const fits = (at: Point) =>
		frames.every((frame) => !near({ ...rect, ...at }, frame, gridSize));
	const lowest = boundsOf(frames);
	const spot = nearestFree(rect, fits) ?? {
		x: rect.x,
		y: ceilToGrid(lowest.y + lowest.height + gridSize),
	};
	return { ...rect, x: spot.x, y: spot.y };
}

export function framesBesideNew(
	cwd: string,
	projects: readonly Group[],
): Rect[] {
	return projects
		.filter((project) => project.region || !belongsTo({ cwd }, project.cwd))
		.map((project) => project.frame);
}

export function storableRegion(rect: Rect): Rect {
	return {
		x: snap(rect.x),
		y: snap(rect.y),
		w: Math.min(maxRegionSize.w, Math.max(minRegionSize.w, snap(rect.w))),
		h: Math.min(maxRegionSize.h, Math.max(minRegionSize.h, snap(rect.h))),
	};
}

export function centredIn<T extends Rect>(
	frame: Rect,
	items: Iterable<T>,
): T[] {
	return [...items].filter((item) => inside(frame, centreOf(item)));
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
	const padded = framedArea({
		x: held.x,
		y: held.y,
		w: held.width,
		h: held.height,
	});
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
		const home = regions
			.filter((region) => housedBy(region, session.cwd, node))
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

function lastStart(start: number, span: number, card: number): number {
	const room = span - gridSize;
	return start + room - (card <= room ? card : card / 2);
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
			lastStart(region.x, region.w, sessionSize.w),
		),
		y: Math.min(
			Math.max(point.y, region.y),
			lastStart(region.y, region.h, sessionSize.h),
		),
	});
	return nearestFree(
		start,
		(at) =>
			inside(region, centreOf(card(at))) &&
			taken.every((r) => !near(card(at), r, gridSize)),
	);
}

export function spotBelowRegion(
	point: Point,
	region: Rect,
	taken: readonly Rect[],
): Point {
	const x = Math.min(
		Math.max(point.x, region.x),
		region.x + region.w - sessionSize.w,
	);
	return clearSpot(
		{ ...snapPoint({ x, y: region.y + region.h }), ...sessionSize },
		taken,
	);
}

export function regionHolding(region: Rect, card: Rect): Rect {
	return areaOf([
		region,
		{
			x: card.x - gridSize,
			y: card.y - gridSize,
			w: card.w + 2 * gridSize,
			h: card.h + 2 * gridSize,
		},
	]);
}

function stepPast(rect: Rect, other: Rect): Point {
	const right = ceilToGrid(other.x + other.w + gridSize - rect.x);
	const down = ceilToGrid(other.y + other.h + gridSize - rect.y);
	return right < down ? { x: right, y: 0 } : { x: 0, y: down };
}

export function pushedApart(
	projects: readonly Pick<Group, "key" | "frame">[],
): Map<string, Point> {
	const settled: Rect[] = [];
	const pushes = new Map<string, Point>();
	const order = [...projects].sort(
		(a, b) =>
			a.frame.y - b.frame.y ||
			a.frame.x - b.frame.x ||
			a.key.localeCompare(b.key),
	);
	for (const { key, frame } of order) {
		let rect = frame;
		for (
			let blocker = settled.find((other) => near(rect, other, gridSize));
			blocker;
			blocker = settled.find((other) => near(rect, other, gridSize))
		) {
			const step = stepPast(rect, blocker);
			rect = { ...rect, x: rect.x + step.x, y: rect.y + step.y };
		}
		settled.push(rect);
		if (rect !== frame)
			pushes.set(key, { x: rect.x - frame.x, y: rect.y - frame.y });
	}
	return pushes;
}
