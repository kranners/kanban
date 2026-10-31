import headless from "@xterm/headless";
import type { MirrorKey, Session } from "../shared/types.ts";
import type { Tty } from "./answer.ts";
import { type AttachPty, escapeGuard, type PtyFactory } from "./attach.ts";
import type { Cmux, CmuxResult, CmuxSurface } from "./cmux.ts";
import { readDialog } from "./screen.ts";

export type RemotePrompt = {
	requestId: string;
	toolUseId: string | null;
	toolName: string;
	title: string;
	input: Record<string, unknown>;
	options: string[];
};

export type RemotePrompts = {
	pending(): RemotePrompt | null;
	choose(requestId: string, label: string): Promise<CmuxResult<null>>;
	answer(
		requestId: string,
		answers: Record<string, string>,
	): Promise<CmuxResult<null>>;
};

export type SessionTty = Tty & {
	send(text: string): Promise<CmuxResult<null>>;
	isOpen(): boolean;
	close(): void;
	prompts?: RemotePrompts;
};

export const attachColumns = 120;
export const attachRows = 40;

const keyBytes: Record<MirrorKey, string> = {
	Enter: "\r",
	Escape: "\x1b",
	Tab: "\t",
	"Shift+Tab": "\x1b[Z",
	Up: "\x1b[A",
	Down: "\x1b[B",
	Backspace: "\x7f",
	"Ctrl+C": "\x03",
};

export const keySequence = (keys: MirrorKey[]): string[] =>
	keys.map((key) => keyBytes[key]);

export const bracketedPaste = (text: string): string =>
	`\x1b[200~${text}\x1b[201~`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const done: CmuxResult<null> = { ok: true, value: null };

const showingPrompt: CmuxResult<null> = {
	ok: false,
	error:
		"The session is showing a prompt or menu, so nothing was submitted. Answer it first.",
};

export const cmuxTty = (deps: {
	cmux: Cmux;
	resolve(session: Session): Promise<CmuxResult<CmuxSurface>>;
	session: Session;
	keyGapMs?: number;
	reuseMs?: number;
}): SessionTty => {
	const keyGapMs = deps.keyGapMs ?? 40;
	const reuseMs = deps.reuseMs ?? 3000;
	let cached: { target: CmuxSurface; at: number } | null = null;
	const target = async (): Promise<CmuxResult<CmuxSurface>> => {
		if (cached && Date.now() - cached.at < reuseMs) {
			return { ok: true, value: cached.target };
		}
		const resolved = await deps.resolve(deps.session);
		cached = resolved.ok ? { target: resolved.value, at: Date.now() } : null;
		return resolved;
	};
	return {
		async screen() {
			const resolved = await target();
			return resolved.ok ? deps.cmux.readScreen(resolved.value) : resolved;
		},
		async keys(keys) {
			const resolved = await target();
			if (!resolved.ok) return resolved;
			for (const key of keys) {
				const sent = await deps.cmux.sendKey(resolved.value, key);
				if (!sent.ok) return sent;
				await wait(keyGapMs);
			}
			return done;
		},
		async paste(text) {
			const resolved = await target();
			return resolved.ok
				? deps.cmux.paste(resolved.value, text, false, true)
				: resolved;
		},
		async send(text) {
			cached = null;
			const resolved = await target();
			return resolved.ok
				? deps.cmux.paste(resolved.value, text, true)
				: resolved;
		},
		isOpen: () => false,
		close() {
			cached = null;
		},
	};
};

export const renderScreen = (terminal: headless.Terminal): string => {
	const buffer = terminal.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < terminal.rows; row++) {
		lines.push(
			buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
		);
	}
	return lines.join("\n");
};

export type PtyScreen = {
	pty: AttachPty;
	terminal: headless.Terminal;
	lastOutput(): number;
};

type Timing = { settleMs: number; keyGapMs: number };

const ptyDriver = (
	live: () => Promise<CmuxResult<PtyScreen>>,
	{ settleMs, keyGapMs }: Timing,
): Pick<SessionTty, "screen" | "keys" | "paste" | "send"> => {
	const quiet = async (screen: PtyScreen) => {
		const deadline = Date.now() + settleMs * 8;
		while (
			Date.now() - screen.lastOutput() < settleMs &&
			Date.now() < deadline
		) {
			await wait(settleMs / 2);
		}
	};
	const showsPrompt = (screen: PtyScreen) =>
		readDialog(renderScreen(screen.terminal)) !== null;
	return {
		async screen() {
			const screen = await live();
			if (!screen.ok) return screen;
			await quiet(screen.value);
			return { ok: true, value: renderScreen(screen.value.terminal) };
		},
		async keys(keys) {
			const screen = await live();
			if (!screen.ok) return screen;
			for (const bytes of keySequence(keys)) {
				screen.value.pty.write(bytes);
				await wait(keyGapMs);
			}
			return done;
		},
		async paste(text) {
			const screen = await live();
			if (!screen.ok) return screen;
			screen.value.pty.write(bracketedPaste(text));
			await wait(keyGapMs);
			return done;
		},
		async send(text) {
			const screen = await live();
			if (!screen.ok) return screen;
			if (showsPrompt(screen.value)) return showingPrompt;
			screen.value.pty.write(bracketedPaste(text));
			await wait(400);
			if (showsPrompt(screen.value)) return showingPrompt;
			screen.value.pty.write(keyBytes.Enter);
			await wait(keyGapMs);
			return done;
		},
	};
};

export const sharedAttachTty = (deps: {
	live(): PtyScreen | null;
	settleMs?: number;
	keyGapMs?: number;
}): SessionTty => ({
	...ptyDriver(
		async () => {
			const screen = deps.live();
			return screen
				? { ok: true, value: screen }
				: { ok: false, error: "The terminal view of this session closed" };
		},
		{ settleMs: deps.settleMs ?? 250, keyGapMs: deps.keyGapMs ?? 60 },
	),
	isOpen: () => deps.live() !== null,
	close() {},
});

export const attachTty = (deps: {
	spawnPty: PtyFactory;
	short: string;
	cwd: string;
	configDir?: string;
	onExit?: () => void;
	readyMs?: number;
	settleMs?: number;
	keyGapMs?: number;
}): SessionTty => {
	const readyMs = deps.readyMs ?? 8000;
	const settleMs = deps.settleMs ?? 250;
	const keyGapMs = deps.keyGapMs ?? 60;
	let pty: AttachPty | null = null;
	let terminal: headless.Terminal | null = null;
	let lastOutput = 0;
	let exited = false;
	let closed = false;
	let ready: Promise<boolean> | null = null;

	const screenText = (): string =>
		terminal ? renderScreen(terminal).replace(/\s+$/, "") : "";

	const open = (): Promise<boolean> => {
		if (closed) return Promise.resolve(false);
		if (ready) return ready;
		exited = false;
		const screen = new headless.Terminal({
			cols: attachColumns,
			rows: attachRows,
			allowProposedApi: true,
			scrollback: 0,
		});
		const child = deps.spawnPty(
			{ short: deps.short, cwd: deps.cwd, configDir: deps.configDir },
			attachColumns,
			attachRows,
		);
		const guard = escapeGuard((key) => child.write(key));
		terminal = screen;
		pty = child;
		lastOutput = Date.now();
		child.onData((data) => {
			lastOutput = Date.now();
			guard(data);
			screen.write(data);
		});
		child.onExit(() => {
			exited = true;
			ready = null;
			pty = null;
			deps.onExit?.();
		});
		ready = (async () => {
			const deadline = Date.now() + readyMs;
			while (!exited && Date.now() < deadline) {
				await wait(100);
				if (Date.now() - lastOutput >= settleMs * 2 && screenText() !== "") {
					return true;
				}
			}
			return !exited;
		})();
		return ready;
	};

	return {
		...ptyDriver(
			async () =>
				(await open()) && pty && terminal
					? {
							ok: true,
							value: { pty, terminal, lastOutput: () => lastOutput },
						}
					: { ok: false, error: "Could not attach to the session" },
			{ settleMs, keyGapMs },
		),
		isOpen: () => pty !== null,
		close() {
			closed = true;
			pty?.kill("SIGHUP");
			pty = null;
			ready = null;
			terminal?.dispose();
			terminal = null;
		},
	};
};
