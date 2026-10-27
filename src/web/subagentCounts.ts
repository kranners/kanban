import type { Subagent } from "../shared/types.ts";

export type SubagentState = "working" | "idle" | "done";

export const subagentStateOrder: SubagentState[] = ["working", "idle", "done"];

export function subagentState(subagent: Subagent): SubagentState {
	if (subagent.live) return "working";
	return subagent.done ? "done" : "idle";
}

export function subagentCounts(
	subagents: readonly Subagent[],
): Record<SubagentState, number> {
	const counts = { working: 0, idle: 0, done: 0 };
	for (const subagent of subagents) counts[subagentState(subagent)] += 1;
	return counts;
}

export function sessionsWithWorkingSubagents(
	subagents: readonly Subagent[],
): Set<string> {
	return new Set(subagents.filter((a) => a.live).map((a) => a.sessionId));
}

export function subagentSummary(counts: Record<SubagentState, number>): string {
	const total = counts.working + counts.idle + counts.done;
	const parts = subagentStateOrder
		.filter((state) => counts[state] > 0)
		.map((state) => `${counts[state]} ${state}`);
	return `${total} ${total === 1 ? "subagent" : "subagents"}: ${parts.join(", ")}`;
}
