import type { Session } from "../shared/types.ts";
import type { Audit } from "./audit.ts";
import type { OpenPrompt, PromptApprover } from "./boardTools.ts";
import { seriousEffect } from "./effects.ts";

const isQuestion = (prompt: OpenPrompt) =>
	prompt.toolName === "AskUserQuestion";

/** What a prompt would do, clipped to one line, for Aaron to judge it by. */
export const promptDetail = (prompt: OpenPrompt): string => {
	const { input } = prompt;
	const shown =
		typeof input.command === "string"
			? input.command
			: typeof input.file_path === "string"
				? input.file_path
				: JSON.stringify(input);
	const line = shown.replace(/\s+/g, " ").trim();
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/**
 * Allows every harmless permission prompt a cloud session waits on, as soon
 * as the board sees it, and leaves serious ones and questions for Aaron.
 * Terminal sessions are left alone: their prompt is read off a screen, so
 * which tool it belongs to is a guess. Each prompt is judged once, and an
 * allow that fails is tried again but audited once.
 */
export const createAutoAnswer = (deps: {
	sessions: () => readonly Session[];
	approver: PromptApprover;
	audit: Audit;
}) => {
	const judged = new Set<string>();
	const failed = new Set<string>();
	let running = false;
	return async () => {
		if (running) return;
		running = true;
		try {
			for (const session of deps.sessions()) {
				if (!session.cloud || session.activity !== "needs-you") continue;
				const open = await deps.approver.open(session);
				if (!open.ok) continue;
				for (const prompt of open.value) {
					if (judged.has(prompt.requestId)) continue;
					judged.add(prompt.requestId);
					if (isQuestion(prompt)) continue;
					if (seriousEffect(prompt.toolName, prompt.input) !== null) continue;
					const approved = await deps.approver.approve(session, prompt);
					if (!approved.ok) judged.delete(prompt.requestId);
					if (!approved.ok && failed.has(prompt.requestId)) continue;
					if (!approved.ok) failed.add(prompt.requestId);
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
			}
		} finally {
			running = false;
		}
	};
};
