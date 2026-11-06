import type { SubagentCounts } from "../shared/subagents.ts";
import type { Subagent, Workflow } from "../shared/types.ts";

export const chipLimit = 4;
const nameLength = 28;

export type SubagentChips = { shown: Subagent[]; more: number };

/**
 * The agent subagents a session card shows as chips: its newest few, newest
 * first, and how many more it has. The count of more comes from the board's
 * subagent counts, which cover every recent subagent, not only the cards sent.
 */
export function subagentChips(
	subagents: readonly Subagent[],
	sessionId: string,
	counts: SubagentCounts | undefined,
	limit = chipLimit,
): SubagentChips {
	const own = subagents
		.filter(
			(subagent) =>
				subagent.sessionId === sessionId && subagent.kind === "agent",
		)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const shown = own.slice(0, limit);
	const total = counts ? counts.working + counts.idle + counts.done : 0;
	return { shown, more: Math.max(total, own.length) - shown.length };
}

/** A chip's label: the subagent's description, else its type, clipped. */
export function chipName(subagent: Subagent): string {
	const name = subagent.description.trim() || subagent.type;
	return name.length > nameLength
		? `${name.slice(0, nameLength - 1).trimEnd()}…`
		: name;
}

/** "6 agents", from the run's agents the board knows, else its journal. */
export function workflowAgents(
	workflow: Workflow,
	runs: Readonly<Record<string, readonly string[]>>,
): string | null {
	const count = Math.max(runs[workflow.runId]?.length ?? 0, workflow.total);
	if (count === 0) return null;
	return `${count} ${count === 1 ? "agent" : "agents"}`;
}

/** A workflow line's text after its name: progress, agents and whether done. */
export function workflowDetail(
	workflow: Workflow,
	runs: Readonly<Record<string, readonly string[]>>,
): string {
	const agents = workflowAgents(workflow, runs);
	const progress =
		workflow.total > 0 && workflow.endedAt === undefined
			? `${workflow.done}/${workflow.total}`
			: null;
	const state = workflow.endedAt === undefined ? null : "done";
	return [progress, agents, state].filter(Boolean).join(" · ");
}

/** Running runs first, then those that ended, most recent first. */
export function orderWorkflows(workflows: readonly Workflow[]): Workflow[] {
	return [...workflows].sort((a, b) => {
		const ended =
			(a.endedAt === undefined ? 0 : 1) - (b.endedAt === undefined ? 0 : 1);
		return ended !== 0 ? ended : (b.endedAt ?? 0) - (a.endedAt ?? 0);
	});
}
