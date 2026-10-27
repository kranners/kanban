import type { Session } from "../shared/types.ts";
import type { AttachPty, PtyFactory } from "./attach.ts";
import type { Cmux, CmuxResult, CmuxSurface } from "./cmux.ts";

export type PromptResult =
	| { ok: true; via: string }
	| { ok: false; error: string };

export type PromptSender = (
	session: Session,
	text: string,
) => Promise<PromptResult>;

export type PromptDeps = {
	spawnPty: PtyFactory;
	attached: () => string[];
	cmux: Cmux;
	resolve(session: Session): Promise<CmuxResult<CmuxSurface>>;
	settleMs?: number;
	readyTimeoutMs?: number;
	submitDelayMs?: number;
};

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";
const enter = "\r";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const quiet = (
	terminal: AttachPty,
	settleMs: number,
	timeoutMs: number,
): Promise<boolean> =>
	new Promise((resolve) => {
		let exited = false;
		let settle: NodeJS.Timeout | undefined;
		const giveUp = setTimeout(() => finish(!exited), timeoutMs);
		const finish = (ready: boolean) => {
			clearTimeout(settle);
			clearTimeout(giveUp);
			resolve(ready);
		};
		terminal.onData(() => {
			clearTimeout(settle);
			settle = setTimeout(() => finish(true), settleMs);
		});
		terminal.onExit(() => {
			exited = true;
			finish(false);
		});
	});

export const blockedReason = (
	session: Session,
	attached: string[],
): string | null => {
	if (session.activity === "needs-you") {
		return "The session is waiting on a question or permission prompt, so typing would answer it. Ask the user to look at it.";
	}
	if (session.kind === "background") {
		if (!session.attachable || session.short === null) {
			return "This background session cannot be attached";
		}
		if (attached.includes(session.short)) {
			return "Someone has this session open on the board, so the prompt was not sent";
		}
		return null;
	}
	return session.cmux
		? null
		: "This terminal session is not in a cmux pane, so the board cannot type into it";
};

export const createPromptSender = (deps: PromptDeps): PromptSender => {
	const settleMs = deps.settleMs ?? 1500;
	const readyTimeoutMs = deps.readyTimeoutMs ?? 15_000;
	const submitDelayMs = deps.submitDelayMs ?? 400;

	const typeInto = async (
		session: Session,
		text: string,
	): Promise<PromptResult> => {
		const terminal = deps.spawnPty(
			{ short: session.short ?? "", cwd: session.cwd },
			120,
			40,
		);
		try {
			if (!(await quiet(terminal, settleMs, readyTimeoutMs))) {
				return { ok: false, error: "Could not attach to the session" };
			}
			terminal.write(`${pasteStart}${text}${pasteEnd}`);
			await wait(submitDelayMs);
			terminal.write(enter);
			await wait(submitDelayMs);
			return { ok: true, via: "claude attach" };
		} finally {
			terminal.kill("SIGHUP");
		}
	};

	return async (session, text) => {
		const blocked = blockedReason(session, deps.attached());
		if (blocked) return { ok: false, error: blocked };
		if (session.kind === "background") return typeInto(session, text);
		const target = await deps.resolve(session);
		if (!target.ok) return target;
		const pasted = await deps.cmux.paste(target.value, text, true);
		return pasted.ok ? { ok: true, via: "cmux paste" } : pasted;
	};
};
