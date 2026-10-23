import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExitResult, Session } from "../shared/types.ts";
import { stripAnsi } from "./ansi.ts";
import { isAlive, readRegistry } from "./ingest/registry.ts";

export type Readiness =
	| { ok: true; ready: boolean; reason: string }
	| { ok: false; error: string };

export type CommandResult = { ok: boolean; output: string };

export type ExitDeps = {
	ask(session: Session): Promise<Readiness>;
	stop(short: string): Promise<CommandResult>;
	remove(short: string): Promise<CommandResult>;
	terminate(session: Session): Promise<CommandResult>;
};

export type SessionExiter = (
	session: Session,
	force: boolean,
) => Promise<ExitResult>;

export const readinessSchema = {
	type: "object",
	properties: {
		ready: { type: "boolean" },
		reason: { type: "string" },
	},
	required: ["ready", "reason"],
	additionalProperties: false,
};

export const readinessPrompt =
	"The kanban board is about to end this session for good. Do not do any more work. " +
	"Looking at the conversation so far, is there outstanding work you started or were asked to do that is unfinished, " +
	"or anything that would be lost if the session exited now, such as uncommitted or unpushed changes, a running task, or a question waiting on an answer? " +
	"Set ready to true only if it is safe to exit now. Give the reason in one short sentence.";

export const readinessArgs = (sessionId: string, forkId: string): string[] => [
	"-p",
	"--resume",
	sessionId,
	"--fork-session",
	"--session-id",
	forkId,
	"--no-session-persistence",
	"--tools",
	"",
	"--output-format",
	"json",
	"--json-schema",
	JSON.stringify(readinessSchema),
	"--",
	readinessPrompt,
];

const lastLine = (text: string): string =>
	stripAnsi(text).trim().split("\n").at(-1)?.trim() ?? "";

export const parseReadiness = (stdout: string, stderr = ""): Readiness => {
	let result: unknown;
	try {
		result = JSON.parse(stdout);
	} catch {
		const detail = lastLine(`${stdout}\n${stderr}`);
		return {
			ok: false,
			error: detail
				? `Could not ask the session: ${detail}`
				: "Could not ask the session",
		};
	}
	const record = (result ?? {}) as Record<string, unknown>;
	const answer = record.structured_output as Record<string, unknown> | null;
	if (record.is_error === true || typeof answer?.ready !== "boolean") {
		const detail =
			typeof record.result === "string" ? lastLine(record.result) : "";
		return {
			ok: false,
			error: detail
				? `The session did not answer: ${detail}`
				: "The session did not answer",
		};
	}
	const reason = typeof answer.reason === "string" ? answer.reason.trim() : "";
	return {
		ok: true,
		ready: answer.ready,
		reason: reason || (answer.ready ? "Nothing outstanding" : "Not finished"),
	};
};

export const exitSession = async (
	deps: ExitDeps,
	session: Session,
	force: boolean,
): Promise<ExitResult> => {
	if (session.kind === "interactive" && session.pid === null) {
		return { ok: false, error: "This session is not running" };
	}
	if (session.kind === "background" && session.short === null) {
		return { ok: false, error: "This session has no background id" };
	}
	if (!force) {
		const readiness = await deps.ask(session);
		if (!readiness.ok) return readiness;
		if (!readiness.ready) {
			return { ok: true, exited: false, reason: readiness.reason };
		}
	}
	if (session.kind === "interactive") {
		const terminated = await deps.terminate(session);
		return terminated.ok
			? { ok: true, exited: true }
			: { ok: false, error: terminated.output };
	}
	const short = session.short ?? "";
	await deps.stop(short);
	const removed = await deps.remove(short);
	return removed.ok
		? { ok: true, exited: true }
		: {
				ok: false,
				error: `Stopped, but claude rm refused: ${removed.output || "no output"}`,
			};
};

const run = (
	claudeBin: string,
	args: string[],
	cwd: string | undefined,
	timeout: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
	new Promise((resolve) => {
		execFile(
			claudeBin,
			args,
			{ cwd, timeout, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }),
		);
	});

const askTimeoutMs = 5 * 60_000;
const commandTimeoutMs = 2 * 60_000;
const probeForgetMs = 60_000;

export const claudeExitDeps = (opts: {
	claudeBin: string;
	claudeHome: string;
	probes: Set<string>;
}): ExitDeps => {
	const command = async (args: string[]): Promise<CommandResult> => {
		const result = await run(opts.claudeBin, args, undefined, commandTimeoutMs);
		return {
			ok: result.ok,
			output: lastLine(`${result.stdout}\n${result.stderr}`),
		};
	};
	return {
		async ask(session) {
			const forkId = randomUUID();
			opts.probes.add(forkId);
			try {
				const result = await run(
					opts.claudeBin,
					readinessArgs(session.id, forkId),
					session.cwd || undefined,
					askTimeoutMs,
				);
				return parseReadiness(result.stdout, result.stderr);
			} finally {
				setTimeout(() => opts.probes.delete(forkId), probeForgetMs).unref();
			}
		},
		stop: (short) => command(["stop", short]),
		remove: (short) => command(["rm", short]),
		async terminate(session) {
			const entry = readRegistry(opts.claudeHome).find(
				(entry) => entry.pid === session.pid,
			);
			if (
				!entry ||
				entry.sessionId !== session.id ||
				entry.kind !== "interactive" ||
				!isAlive(entry.pid)
			) {
				return {
					ok: false,
					output: "The session's process is no longer the one on the board",
				};
			}
			try {
				process.kill(entry.pid, "SIGTERM");
				return { ok: true, output: "" };
			} catch (error) {
				return {
					ok: false,
					output: `Could not signal the session: ${(error as Error).message}`,
				};
			}
		},
	};
};

export const sessionExiter = (deps: ExitDeps): SessionExiter => {
	const inFlight = new Set<string>();
	return async (session, force) => {
		if (inFlight.has(session.id)) {
			return { ok: false, error: "This session is already exiting" };
		}
		inFlight.add(session.id);
		try {
			return await exitSession(deps, session, force);
		} finally {
			inFlight.delete(session.id);
		}
	};
};
