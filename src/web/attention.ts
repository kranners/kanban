import { subagentState } from "../shared/subagents.ts";
import type { Activity, Board, Point } from "../shared/types.ts";
import type { KeyPress } from "./actions.ts";
import type { NodeKey } from "./layout.ts";
import { nodeKey } from "./layout.ts";

export type Activities = ReadonlyMap<NodeKey, Activity>;

const markedArrivals: ReadonlySet<Activity> = new Set(["done", "failed"]);

export function activitiesOf(board: Board): Map<NodeKey, Activity> {
	return new Map([
		...board.sessions.map(
			(s) => [nodeKey({ kind: "session", id: s.id }), s.activity] as const,
		),
		...board.subagents.map(
			(a) =>
				[nodeKey({ kind: "subagent", id: a.id }), subagentState(a)] as const,
		),
	]);
}

export function arrivals(
	previous: Activities,
	current: Activities,
): Map<NodeKey, Activity> {
	const arrived = new Map<NodeKey, Activity>();
	for (const [key, activity] of current) {
		const before = previous.get(key);
		if (before && before !== activity && markedArrivals.has(activity))
			arrived.set(key, activity);
	}
	return arrived;
}

export function needingYou(activities: Activities): Set<NodeKey> {
	return new Set(
		[...activities].flatMap(([key, activity]) =>
			activity === "needs-you" ? [key] : [],
		),
	);
}

export function countNeedingYou(
	members: readonly NodeKey[],
	needing: ReadonlySet<NodeKey>,
): number {
	return members.filter((key) => needing.has(key)).length;
}

const readingCompare = (a: Point, b: Point) => a.y - b.y || a.x - b.x;

export function readingOrder<T extends Point & { key: NodeKey }>(
	nodes: readonly T[],
): T[] {
	return [...nodes].sort(readingCompare);
}

export function nextInLine<T extends Point>(
	ordered: readonly T[],
	after: Point | null,
): T | undefined {
	return (
		(after && ordered.find((node) => readingCompare(node, after) > 0)) ??
		ordered[0]
	);
}

export function isNextNeedingYouKey(press: KeyPress, typing: boolean): boolean {
	return (
		press.key.toLowerCase() === "j" &&
		!press.altKey &&
		!press.ctrlKey &&
		!press.metaKey &&
		!press.shiftKey &&
		!typing
	);
}
