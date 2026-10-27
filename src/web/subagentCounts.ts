import {
	noSubagents,
	type SubagentCounts,
	type SubagentState,
} from "../shared/subagents.ts";
import type { Subagent } from "../shared/types.ts";

export const subagentStateOrder: SubagentState[] = ["working", "idle", "done"];

export function totalSubagentCounts(
	bySession: Readonly<Record<string, SubagentCounts>>,
): SubagentCounts {
	const total = noSubagents();
	for (const counts of Object.values(bySession))
		for (const state of subagentStateOrder) total[state] += counts[state];
	return total;
}

export function sessionsWithWorkingSubagents(
	subagents: readonly Subagent[],
): Set<string> {
	return new Set(subagents.filter((a) => a.live).map((a) => a.sessionId));
}

export function subagentSummary(counts: SubagentCounts): string {
	const total = counts.working + counts.idle + counts.done;
	const parts = subagentStateOrder
		.filter((state) => counts[state] > 0)
		.map((state) => `${counts[state]} ${state}`);
	return `${total} ${total === 1 ? "subagent" : "subagents"}: ${parts.join(", ")}`;
}
