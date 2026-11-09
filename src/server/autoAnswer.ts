import type { Session } from "../shared/types.ts";
import type { Audit } from "./audit.ts";
import type { OpenPrompt, PromptApprover } from "./boardTools.ts";
import { promptVerdict, type SafeVerdict } from "./safePrompts.ts";

/**
 * Who answers board sessions' permission prompts, from KANBAN_PERMISSIONS_MODE,
 * which spike sets from butler.permissions.mode: legacy leaves them to the safe
 * sweep, Butler's reviewer and Aaron; effects has the board allow each prompt
 * of a cloud session the safe set allows as soon as it appears and leave the
 * rest for Aaron; off, the hard stop, also refuses the rest.
 */
export const permissionsModes = ["legacy", "effects", "off"] as const;
export type PermissionsMode = (typeof permissionsModes)[number];
export const permissionsMode = (
	value: string | undefined = process.env.KANBAN_PERMISSIONS_MODE,
): PermissionsMode =>
	permissionsModes.find((mode) => mode === value?.trim()) ?? "legacy";

/** The safe set's verdict on a cloud session's prompt, judging other sessions it names by whether they are on the board. */
export const cloudVerdict = (
	session: Session,
	prompt: OpenPrompt,
	onBoard: (id: string) => boolean,
): SafeVerdict =>
	promptVerdict(prompt.toolName, prompt.title, prompt.input, undefined, {
		self: session.id,
		onBoard,
	});

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
 * Allows each prompt of a cloud session the safe set allows, as soon as the
 * board sees it, and leaves the rest and every question for Aaron, or refuses
 * the rest while the mode is off. Terminal sessions are left alone: their
 * prompt is read off a screen, so which tool it belongs to is a guess. Each
 * prompt is judged once, and an allow that fails is tried again but audited
 * once.
 */
export const createAutoAnswer = (deps: {
	sessions: () => readonly Session[];
	approver: PromptApprover;
	audit: Audit;
	mode: Exclude<PermissionsMode, "legacy">;
}) => {
	const judged = new Set<string>();
	const failed = new Set<string>();
	let running = false;
	return async () => {
		if (running) return;
		running = true;
		try {
			const sessions = deps.sessions();
			const onBoard = (id: string) => sessions.some((s) => s.id === id);
			for (const session of sessions) {
				if (!session.cloud || session.activity !== "needs-you") continue;
				const open = await deps.approver.open(session);
				if (!open.ok) continue;
				for (const prompt of open.value) {
					if (judged.has(prompt.requestId)) continue;
					judged.add(prompt.requestId);
					if (prompt.toolName === "AskUserQuestion") continue;
					const leftForAaron = !cloudVerdict(session, prompt, onBoard).safe;
					if (leftForAaron && deps.mode === "effects") continue;
					const answered = leftForAaron
						? await deps.approver.refuse(session, prompt)
						: await deps.approver.approve(session, prompt);
					if (!answered.ok) judged.delete(prompt.requestId);
					if (!answered.ok && failed.has(prompt.requestId)) continue;
					if (!answered.ok) failed.add(prompt.requestId);
					deps.audit({
						action: "prompt-approve",
						sessionId: session.id,
						tool: prompt.toolName,
						requestId: prompt.requestId,
						via: leftForAaron ? "refused, permissions off" : "safe set",
						identity: null,
						result: answered.ok ? "ok" : answered.error,
					});
				}
			}
		} finally {
			running = false;
		}
	};
};
