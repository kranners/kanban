import {
	noSubagents,
	outstandingSubagents,
	type SubagentCounts,
	type SubagentState,
} from "../shared/subagents.ts";
import type { Subagent } from "../shared/types.ts";
import { type NodeKey, nodeKey } from "./layout.ts";

export const subagentStateOrder: SubagentState[] = ["working", "idle", "done"];

export function totalSubagentCounts(
	bySession: Readonly<Record<string, SubagentCounts>>,
): SubagentCounts {
	const total = noSubagents();
	for (const counts of Object.values(bySession))
		for (const state of subagentStateOrder) total[state] += counts[state];
	return total;
}

export function memberSubagentCounts(
	members: readonly NodeKey[],
	bySession: Readonly<Record<string, SubagentCounts>>,
): SubagentCounts {
	const keys = new Set(members);
	return totalSubagentCounts(
		Object.fromEntries(
			Object.entries(bySession).filter(([id]) =>
				keys.has(nodeKey({ kind: "session", id })),
			),
		),
	);
}

export function sessionsWithWorkingSubagents(
	subagents: readonly Subagent[],
): Set<string> {
	return new Set(subagents.filter((a) => a.live).map((a) => a.sessionId));
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
