import { signal } from "@preact/signals";
import type { Board } from "../shared/types.ts";

// Whether the board shows subagents, kept per browser: on unless turned off.

export const showSubagentsKey = "kanban.showSubagents";

function read(): boolean {
	try {
		return localStorage.getItem(showSubagentsKey) !== "off";
	} catch {
		return true;
	}
}

export const showSubagents = signal(read());

export function setShowSubagents(shown: boolean): void {
	showSubagents.value = shown;
	try {
		localStorage.setItem(showSubagentsKey, shown ? "on" : "off");
	} catch {}
}

/** The board as the page draws it: with subagents hidden, no subagent cards, chips or counts. */
export function withSubagentsShown(board: Board, shown: boolean): Board {
	if (shown) return board;
	return {
		...board,
		subagents: [],
		subagentCounts: {},
		subagentStates: {},
		links: board.links.filter(
			(link) => link.from.kind !== "subagent" && link.to.kind !== "subagent",
		),
		messages: board.messages.filter(
			(message) =>
				message.from.kind !== "subagent" && message.to.kind !== "subagent",
		),
	};
}
