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
 * transcript, since its subagents' own files never reach this machine, a
 * subagent's own subagents nested under it. One not finished stays while
 * the session is on the board, and a finished one for an hour after it
 * ended, the session's end counting as its end when it never reported
 * back, newest first up to the same 40 card limit as local subagents.
 */
export function cloudSubagents(
	sessionId: string,
	facts: TranscriptFacts,
	activity: Activity,
	now: number,
): Subagent[] {
	const ended = over.includes(activity);
	const idOf = (toolUseId: string) => {
		const call = facts.agentCalls.get(toolUseId);
		return call ? (call.agentId ?? call.toolUseId) : null;
	};
	return [...facts.agentCalls.values()]
		.map((call): Subagent => {
			const done = call.endedAt !== null || ended;
			const endedAt =
				call.endedAt ?? (ended ? Math.max(call.updatedAt, facts.lastAt) : null);
			return {
				id: call.agentId ?? call.toolUseId,
				kind: "agent",
				sessionId,
				parentAgentId: call.parentToolUseId ? idOf(call.parentToolUseId) : null,
				type: call.type,
				description: call.description,
				live:
					!done &&
					(now - call.updatedAt <= subagentLiveMs || activity === "working"),
				done,
				startedAt: call.startedAt,
				updatedAt: endedAt ?? call.updatedAt,
			};
		})
		.filter(
			(subagent) =>
				!subagent.done || now - subagent.updatedAt <= subagentWindowMs,
		)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, subagentLimit);
}

/**
 * A cloud session's workflow runs, running or ended in the last hour.
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
