import {
	noSubagents,
	outstandingSubagents,
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
	return new Set(subagents.filter(isWorkingAgent).map((a) => a.sessionId));
}

export function isWorkingAgent(subagent: Subagent | undefined): boolean {
	return subagent?.kind === "agent" && subagent.live;
}

export function subagentHeadline(
	counts: SubagentCounts,
	waiting = "waiting on",
): string {
	const outstanding = outstandingSubagents(counts);
	return [
		counts.working > 0 && `${counts.working} running`,
		outstanding > 0 && `${outstanding} ${waiting}`,
	]
		.filter(Boolean)
		.join(" · ");
}

export function subagentSummary(counts: SubagentCounts): string {
	const total = counts.working + counts.idle + counts.done;
	const detail = [
		subagentHeadline(counts),
		counts.idle > 0 && `${counts.idle} stalled`,
		counts.done > 0 && `${counts.done} done`,
	]
		.filter(Boolean)
		.join(" · ");
	return `${total} ${total === 1 ? "subagent" : "subagents"}: ${detail}`;
}
