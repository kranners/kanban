import type { Subagent } from "../../shared/types.ts";
import type { TranscriptFacts } from "./records.ts";
import { subagentWindowMs } from "./subagents.ts";

export type ShellOwner = {
	sessionId: string;
	parentAgentId: string | null;
	facts: TranscriptFacts;
	endedAt: number | null;
};

export function shellsOf(owner: ShellOwner, now: number): Subagent[] {
	return [...owner.facts.shells].flatMap(([id, shell]) => {
		const endedAt = shell.endedAt ?? owner.endedAt;
		if (endedAt !== null && now - endedAt > subagentWindowMs) return [];
		const done = endedAt !== null;
		return [
			{
				id,
				kind: "shell",
				sessionId: owner.sessionId,
				parentAgentId: owner.parentAgentId,
				type: shell.tool === "Monitor" ? "monitor" : "shell",
				description: shell.description,
				live: !done,
				done,
				startedAt: shell.startedAt,
				updatedAt: endedAt ?? shell.startedAt,
			},
		];
	});
}
