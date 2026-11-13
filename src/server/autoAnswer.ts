import type { Session } from "../shared/types.ts";
import type { Audit } from "./audit.ts";
import type { OpenPrompt, PromptApprover } from "./boardTools.ts";
import { reviewedHold } from "./promptReviews.ts";
import { promptVerdict, type SafeVerdict } from "./safePrompts.ts";

/**
 * Who answers board sessions' permission prompts, from KANBAN_PERMISSIONS_MODE,
 * which spike sets from butler.permissions.mode: effects has the board allow
 * each prompt of a cloud session its one decision path allows as soon as it
 * appears and leave the rest for Aaron; off, the hard stop, also refuses the
 * rest; legacy, the default, answers nothing and leaves every prompt to him.
 */
export const permissionsModes = ["legacy", "effects", "off"] as const;
export type PermissionsMode = (typeof permissionsModes)[number];
export const permissionsMode = (
	value: string | undefined = process.env.KANBAN_PERMISSIONS_MODE,
): PermissionsMode =>
	permissionsModes.find((mode) => mode === value?.trim()) ?? "legacy";

type Judged = Pick<OpenPrompt, "toolName" | "title" | "input">;

/**
 * The board's one decision on a session's permission prompt: allowed when the
 * safe set allows it and nothing about one of claude.ai's session tools
 * holds it, otherwise left for Aaron with why. Other sessions it names are
 * judged by whether they are on the board; cwd is a terminal session's folder.
 */
export const promptDecision = (
	prompt: Judged,
	targets: { self: string; onBoard: (id: string) => boolean; cwd?: string },
): SafeVerdict => {
	const onBoard = (id: string) => id === targets.self || targets.onBoard(id);
	const verdict = promptVerdict(
		prompt.toolName,
		prompt.title,
		prompt.input,
		targets.cwd,
		{ self: targets.self, onBoard },
	);
	if (!verdict.safe) return verdict;
	const held = reviewedHold(prompt.toolName, prompt.input, onBoard);
	return held === null ? verdict : { safe: false, reason: held };
};

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
 * Allows each prompt of a cloud session promptDecision allows, as soon as the
 * board sees it, and leaves the rest and every question for Aaron, or refuses
 * the rest while the mode is off. Terminal sessions are left alone: their
 * prompt is read off a screen, so which tool it belongs to is a guess. Each
 * prompt is judged once and audited once, as approved, held with why or
 * refused; an allow that fails is tried again but audited once.
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
					const decision = promptDecision(prompt, {
						self: session.id,
						onBoard,
					});
					const leftForAaron = !decision.safe;
					if (leftForAaron && deps.mode === "effects") {
						deps.audit({
							action: "prompt-hold",
							sessionId: session.id,
							tool: prompt.toolName,
							requestId: prompt.requestId,
							via: "safe set",
							identity: null,
							result: decision.reason ?? "left for Aaron",
						});
						continue;
					}
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
