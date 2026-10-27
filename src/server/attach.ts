import { existsSync } from "node:fs";
import { homedir } from "node:os";
import headless from "@xterm/headless";
import * as pty from "node-pty";
import type { AttachClientFrame, AttachServerNotice } from "../shared/types.ts";
import { stripAnsi } from "./ansi.ts";
import type { Audit } from "./audit.ts";

export type AttachPty = {
	onData(listener: (data: string) => void): unknown;
	onExit(listener: (event: { exitCode: number }) => void): unknown;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
};

export type AttachTarget = { short: string; cwd: string };

export type PtyFactory = (
	target: AttachTarget,
	cols: number,
	rows: number,
) => AttachPty;

export type AttachSocket = {
	readonly readyState: number;
	send(data: string | Buffer): void;
	close(code?: number, reason?: string): void;
	on(event: "message", listener: (data: unknown) => void): unknown;
	on(event: "close", listener: () => void): unknown;
};

export type TerminalSize = { cols: number; rows: number };

const socketOpen = 1;
const enter = "\r";
const escapeKey = String.fromCharCode(27);
const escapeRules = [
	{ markers: ["describeataskforanewsession", "entertoreturn"], key: enter },
	{ markers: ["accessingworkspace:", "yes,itrustthisfolder"], key: escapeKey },
];
const tailLimit = 4096;
const escapeDebounceMs = 1000;

export const isValidShort = (short: string): boolean =>
	/^[0-9a-f]{8}$/.test(short);

const clampDimension = (raw: unknown, fallback: number): number => {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 2) return fallback;
	return Math.min(value, 500);
};

export const parseSize = (
	cols: string | null,
	rows: string | null,
): TerminalSize => ({
	cols: clampDimension(cols ?? undefined, 120),
	rows: clampDimension(rows ?? undefined, 40),
});

export const parseClientFrame = (raw: unknown): AttachClientFrame | null => {
	try {
		const frame: unknown = JSON.parse(String(raw));
		if (typeof frame !== "object" || frame === null) return null;
		const { t, d, cols, rows } = frame as Record<string, unknown>;
		if (t === "in" && typeof d === "string") return { t, d };
		if (
			t === "resize" &&
			Number.isInteger(cols) &&
			Number.isInteger(rows) &&
			(cols as number) >= 2 &&
			(rows as number) >= 2
		) {
			return {
				t,
				cols: Math.min(cols as number, 500),
				rows: Math.min(rows as number, 500),
			};
		}
		return null;
	} catch {
		return null;
	}
};

const windowTitles = new RegExp(
	`${escapeKey}\\][02];([^${String.fromCharCode(7)}${escapeKey}]*)`,
	"g",
);
const agentViewTitle = /claude agents$/;

export const escapeGuard = (
	sendKey: (key: string) => void,
	now: () => number = Date.now,
): ((output: string) => void) => {
	let inAgentView = false;
	let screen = "";
	let lastEscape = Number.NEGATIVE_INFINITY;
	return (output) => {
		let fresh = output;
		for (const match of output.matchAll(windowTitles)) {
			const entering = agentViewTitle.test(match[1] ?? "");
			if (entering && !inAgentView) {
				screen = "";
				fresh = output.slice(match.index);
			}
			inAgentView = entering;
		}
		if (!inAgentView) return;
		screen = (screen + stripAnsi(fresh)).slice(-tailLimit);
		const compact = screen.replace(/\s+/g, "").toLowerCase();
		const rule = escapeRules.find(({ markers }) =>
			markers.every((marker) => compact.includes(marker)),
		);
		if (!rule) return;
		if (now() - lastEscape < escapeDebounceMs) return;
		screen = "";
		lastEscape = now();
		sendKey(rule.key);
	};
};

export const claudeAttachPty =
	(claudeBin: string): PtyFactory =>
	({ short, cwd }, cols, rows) =>
		pty.spawn(claudeBin, ["attach", short], {
			name: "xterm-256color",
			cols,
			rows,
			cwd: existsSync(cwd) ? cwd : homedir(),
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
		});

const notice = (frame: AttachServerNotice): string => JSON.stringify(frame);

type CloseReason = "socket-closed" | "taken-over" | "exited";

export type LiveScreen = {
	pty: AttachPty;
	terminal: headless.Terminal;
	lastOutput(): number;
};

type LiveAttach = { end(reason: CloseReason): void; screen: LiveScreen };

export type AttachHub = {
	open(
		socket: AttachSocket,
		target: AttachTarget,
		size: TerminalSize,
		identity: string | null,
	): void;
	attached(): string[];
	screen(short: string): LiveScreen | null;
};

export const createAttachHub = (
	spawnPty: PtyFactory,
	audit: Audit,
	onChange: (short: string) => void = () => {},
): AttachHub => {
	const live = new Map<string, LiveAttach>();

	const open: AttachHub["open"] = (socket, target, size, identity) => {
		const { short } = target;
		const terminal = spawnPty(target, size.cols, size.rows);
		live.get(short)?.end("taken-over");
		const guard = escapeGuard((key) => terminal.write(key));
		const mirror = new headless.Terminal({
			cols: size.cols,
			rows: size.rows,
			allowProposedApi: true,
			scrollback: 0,
		});
		let lastOutput = Date.now();
		let ended = false;

		const entry: LiveAttach = {
			screen: { pty: terminal, terminal: mirror, lastOutput: () => lastOutput },
			end(reason) {
				if (ended) return;
				ended = true;
				if (live.get(short) === entry) live.delete(short);
				mirror.dispose();
				onChange(short);
				audit({ action: "attach-close", short, identity, reason });
				if (reason !== "exited") terminal.kill("SIGHUP");
				if (reason === "taken-over" && socket.readyState === socketOpen) {
					socket.send(notice({ t: "taken-over" }));
					socket.close(4000, "taken over");
				}
			},
		};
		live.set(short, entry);
		audit({ action: "attach-open", short, identity });
		onChange(short);

		terminal.onData((data) => {
			guard(data);
			if (!ended) {
				lastOutput = Date.now();
				mirror.write(data);
			}
			if (!ended && socket.readyState === socketOpen) {
				socket.send(Buffer.from(data, "utf8"));
			}
		});
		terminal.onExit(({ exitCode }) => {
			if (ended) return;
			entry.end("exited");
			if (socket.readyState === socketOpen) {
				socket.send(notice({ t: "exited", code: exitCode }));
				socket.close(1000, "exited");
			}
		});
		socket.on("message", (raw) => {
			if (ended) return;
			const frame = parseClientFrame(raw);
			if (frame?.t === "in") terminal.write(frame.d);
			if (frame?.t === "resize") {
				terminal.resize(frame.cols, frame.rows);
				mirror.resize(frame.cols, frame.rows);
			}
		});
		socket.on("close", () => entry.end("socket-closed"));
	};

	return {
		open,
		attached: () => [...live.keys()],
		screen: (short) => live.get(short)?.screen ?? null,
	};
};
