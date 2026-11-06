import type { Activity, Subagent, Workflow } from "../../shared/types.ts";
import type { TranscriptFacts } from "./records.ts";
import {
	subagentLimit,
	subagentLiveMs,
	subagentWindowMs,
	workflowShownMs,
} from "./subagents.ts";

/** Activities after which a cloud session's open calls will never return. */
const over: readonly Activity[] = ["done", "failed", "stopped"];

/**
 * A cloud session's subagents, from the Agent and Task calls in its mirrored
 * transcript, since its subagents' own files never reach this machine. The
 * same 30 minute window and 40 card limit apply as for local subagents.
 */
export function cloudSubagents(
	sessionId: string,
	facts: TranscriptFacts,
	activity: Activity,
	now: number,
): Subagent[] {
	const ended = over.includes(activity);
	return [...facts.agentCalls.values()]
		.map((call): Subagent => {
			const done = call.endedAt !== null || ended;
			return {
				id: call.agentId ?? call.toolUseId,
				kind: "agent",
				sessionId,
				parentAgentId: null,
				type: call.type,
				description: call.description,
				live:
					!done &&
					(now - call.updatedAt <= subagentLiveMs || activity === "working"),
				done,
				startedAt: call.startedAt,
				updatedAt: call.endedAt ?? call.updatedAt,
			};
		})
		.filter(
			(subagent) =>
				subagent.live || now - subagent.updatedAt <= subagentWindowMs,
		)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, subagentLimit);
}

/**
 * A cloud session's workflow runs, running or ended in the last 30 minutes.
 * Their agents are not in the mirror, so done and total stay 0.
 */
export function cloudWorkflows(
	sessionId: string,
	facts: TranscriptFacts,
	activity: Activity,
	now: number,
): Workflow[] {
	const ended = over.includes(activity);
	return [...facts.workflowCalls.values()].flatMap((call): Workflow[] => {
		const endedAt = call.endedAt ?? (ended ? call.updatedAt : null);
		if (endedAt !== null && now - endedAt > workflowShownMs) return [];
		const runId = call.runId ?? call.toolUseId;
		return [
			{
				runId,
				sessionId,
				name: facts.workflowNames.get(runId) ?? call.name,
				done: 0,
				total: 0,
				...(endedAt === null ? {} : { endedAt }),
			},
		];
	});
}
