import type { Board, NodeRef, Point } from "../shared/types.ts";
import { gridSize, snapPoint } from "./grid.ts";
import type { Rect } from "./placement.ts";
import { near, nearestFree, sessionSize } from "./placement.ts";

export type KeyPress = {
	key: string;
	repeat: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
};

export function isQuickPromptKey(press: KeyPress, typing: boolean): boolean {
	return (
		press.key.toLowerCase() === "a" &&
		!press.repeat &&
		!press.altKey &&
		!press.ctrlKey &&
		!press.metaKey &&
		!press.shiftKey &&
		!typing
	);
}

export function cwdChoices(
	preferred: string | null,
	known: readonly string[],
): string[] {
	return [...new Set([...(preferred ? [preferred] : []), ...known])];
}

export function cycle<T>(
	options: readonly T[],
	current: T,
	step: number,
): T | undefined {
	if (options.length === 0) return undefined;
	const index = Math.max(0, options.indexOf(current));
	return options[(index + step + options.length) % options.length];
}

export function freeSpotNear(point: Point, taken: readonly Rect[]): Point {
	const start = snapPoint(point);
	const fits = (at: Point) =>
		taken.every((r) => !near({ ...at, ...sessionSize }, r, gridSize));
	return nearestFree(start, fits) ?? start;
}

export function withoutSessions(
	board: Board,
	gone: ReadonlySet<string>,
): Board {
	if (gone.size === 0) return board;
	const subagents = board.subagents.filter((a) => !gone.has(a.sessionId));
	const removedAgents = new Set(
		board.subagents.filter((a) => gone.has(a.sessionId)).map((a) => a.id),
	);
	const kept = (ref: NodeRef) =>
		ref.kind === "session" ? !gone.has(ref.id) : !removedAgents.has(ref.id);
	return {
		...board,
		sessions: board.sessions.filter((s) => !gone.has(s.id)),
		subagents,
		links: board.links.filter((l) => kept(l.from) && kept(l.to)),
		messages: board.messages.filter((m) => kept(m.from) && kept(m.to)),
	};
}
