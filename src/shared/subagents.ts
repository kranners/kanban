import type { Subagent } from "./types.ts";

export type SubagentState = "working" | "idle" | "done";

export type SubagentCounts = Record<SubagentState, number>;

export function subagentState(subagent: Subagent): SubagentState {
	if (subagent.live) return "working";
	return subagent.done ? "done" : "idle";
}

export function noSubagents(): SubagentCounts {
	return { working: 0, idle: 0, done: 0 };
}

export function subagentCountsBySession(
	subagents: readonly Subagent[],
): Record<string, SubagentCounts> {
	const bySession: Record<string, SubagentCounts> = {};
	for (const subagent of subagents) {
		const counts = bySession[subagent.sessionId] ?? noSubagents();
		counts[subagentState(subagent)] += 1;
		bySession[subagent.sessionId] = counts;
	}
	return bySession;
}
