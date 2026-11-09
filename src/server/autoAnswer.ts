import type { Session } from "../shared/types.ts";
import type { Audit } from "./audit.ts";
import type { OpenPrompt, PromptApprover } from "./boardTools.ts";
import { seriousEffect } from "./effects.ts";

/** The serious effect a session's prompt would have, judged where the session runs. */
export const promptEffect = (session: Session, prompt: OpenPrompt) =>
	seriousEffect(
		prompt.toolName,
		prompt.input,
		session.cloud ? undefined : session.cwd,
	);

const isQuestion = (prompt: OpenPrompt) =>
	prompt.toolName === "AskUserQuestion";

/**
 * Allows every harmless permission prompt a session waits on, as soon as the
 * board sees it, and leaves serious ones and questions for Aaron. A waiting
 * state left only with those is not read again until it changes.
 */
export const createAutoAnswer = (deps: {
	sessions: () => readonly Session[];
	approver: PromptApprover;
	audit: Audit;
}) => {
	let settled = new Set<string>();
	let running = false;
	return async () => {
		if (running) return;
		running = true;
		try {
			const waiting = deps
				.sessions()
				.filter((session) => session.activity === "needs-you");
			const current = new Set(
				waiting.map((session) => `${session.id}\n${session.needs ?? ""}`),
			);
			settled = new Set([...settled].filter((key) => current.has(key)));
			for (const session of waiting) {
				const key = `${session.id}\n${session.needs ?? ""}`;
				if (settled.has(key)) continue;
				const open = await deps.approver.open(session);
				if (!open.ok) continue;
				let leftForAaron = false;
				for (const prompt of open.value) {
					if (isQuestion(prompt) || promptEffect(session, prompt) !== null) {
						leftForAaron = true;
						continue;
					}
					const approved = await deps.approver.approve(session, prompt);
					deps.audit({
						action: "prompt-approve",
						sessionId: session.id,
						tool: prompt.toolName,
						requestId: prompt.requestId,
						via: "harmless",
						identity: null,
						result: approved.ok ? "ok" : approved.error,
					});
				}
				if (leftForAaron) settled.add(key);
			}
		} finally {
			running = false;
		}
	};
};
