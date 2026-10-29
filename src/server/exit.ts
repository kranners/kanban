import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExitResult, Session } from "../shared/types.ts";
import { claudeEnv } from "./accounts.ts";
import { lastLine } from "./ansi.ts";
import type { Audit } from "./audit.ts";
import {
	isAlive,
	type RegistryEntry,
	readRegistry,
} from "./ingest/registry.ts";

export type Readiness =
	| { ok: true; ready: boolean; reason: string }
	| { ok: false; error: string };

export type CommandResult = { ok: boolean; output: string };

export type ProcessInfo = { startedAt: number; command: string };

export type ExitDeps = {
	ask(session: Session): Promise<Readiness>;
	stop(session: Session): Promise<CommandResult>;
	remove(session: Session): Promise<CommandResult>;
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

const forkArgs = (sessionId: string, forkId: string): string[] => [
	"-p",
	"--resume",
	sessionId,
	"--fork-session",
	"--session-id",
	forkId,
	"--no-session-persistence",
	"--tools",
	"",
	"--strict-mcp-config",
	"--permission-mode",
	"dontAsk",
	"--settings",
	JSON.stringify({ disableAllHooks: true }),
	"--output-format",
	"json",
];

export const readinessArgs = (sessionId: string, forkId: string): string[] => [
	...forkArgs(sessionId, forkId),
	"--json-schema",
	JSON.stringify(readinessSchema),
	"--",
	readinessPrompt,
];

export const askArgs = (
	sessionId: string,
	forkId: string,
	question: string,
): string[] => [...forkArgs(sessionId, forkId), "--", question];

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
	const stopped = await deps.stop(session);
	if (!stopped.ok) {
		return {
			ok: false,
			error: `claude stop failed: ${stopped.output || "no output"}`,
		};
	}
	const removed = await deps.remove(session);
	return removed.ok
		? { ok: true, exited: true }
		: {
				ok: false,
				error: `Stopped, but claude rm refused: ${removed.output || "no output"}`,
			};
};

export type ExitRunner = (
	session: Session,
	force: boolean,
	identity: string | null,
) => Promise<ExitResult> | null;

export const createExitRunner = (deps: {
	exit: SessionExiter;
	audit: Audit;
	announce: (sessionId: string, result: ExitResult) => void;
}): ExitRunner => {
	const exiting = new Set<string>();
	return (session, force, identity) => {
		if (exiting.has(session.id)) return null;
		exiting.add(session.id);
		return deps
			.exit(session, force)
			.catch(
				(error: unknown): ExitResult => ({
					ok: false,
					error: `Exit failed: ${(error as Error).message}`,
				}),
			)
			.finally(() => exiting.delete(session.id))
			.then((result) => {
				deps.audit({
					action: "session-exit",
					sessionId: session.id,
					short: session.short,
					kind: session.kind,
					force,
					identity,
					result: !result.ok
						? `error: ${result.error}`
						: result.exited
							? "exited"
							: `not ready: ${result.reason}`,
				});
				deps.announce(session.id, result);
				return result;
			});
	};
};

export type Answer =
	| { ok: true; answer: string }
	| { ok: false; error: string };

export const parseAnswer = (stdout: string, stderr = ""): Answer => {
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
	const answer = typeof record.result === "string" ? record.result.trim() : "";
	if (record.is_error === true || !answer) {
		return {
			ok: false,
			error: answer
				? `The session did not answer: ${lastLine(answer)}`
				: "The session did not answer",
		};
	}
	return { ok: true, answer };
};

const run = (
	claudeBin: string,
	args: string[],
	cwd: string | undefined,
	timeout: number,
	configDir?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
	new Promise((resolve) => {
		execFile(
			claudeBin,
			args,
			{
				cwd,
				timeout,
				maxBuffer: 4 * 1024 * 1024,
				env: claudeEnv(configDir),
			},
			(error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }),
		);
	});

const startTolerance = { before: 2000, after: 60_000 };

export const sameProcess = (
	entry: Pick<RegistryEntry, "startedAt">,
	info: ProcessInfo | null,
): boolean => {
	if (!info || !/(^|\/)claude( |$)/.test(info.command)) return false;
	const lag = entry.startedAt - info.startedAt;
	return lag >= -startTolerance.before && lag <= startTolerance.after;
};

const lstartLength = "Sat Oct 24 10:32:40 2026".length;

export const parseProcessInfo = (psLine: string): ProcessInfo | null => {
	const line = psLine.trim();
	const startedAt = new Date(line.slice(0, lstartLength)).getTime();
	const command = line.slice(lstartLength).trim();
	return Number.isFinite(startedAt) && command ? { startedAt, command } : null;
};

const inspectProcess = (pid: number): Promise<ProcessInfo | null> =>
	new Promise((resolve) => {
		execFile(
			"/bin/ps",
			["-o", "lstart=,comm=", "-p", String(pid)],
			{ env: { ...process.env, LC_ALL: "C" }, timeout: 10_000 },
			(error, stdout) => resolve(error ? null : parseProcessInfo(stdout)),
		);
	});

export const liveInteractiveEntry = async (
	claudeHome: string,
	session: Pick<Session, "id" | "pid" | "configDir">,
): Promise<RegistryEntry | null> => {
	const entry = readRegistry(session.configDir ?? claudeHome).find(
		(entry) => entry.pid === session.pid,
	);
	return entry &&
		entry.sessionId === session.id &&
		entry.kind === "interactive" &&
		isAlive(entry.pid) &&
		sameProcess(entry, await inspectProcess(entry.pid))
		? entry
		: null;
};

const askTimeoutMs = 5 * 60_000;
const commandTimeoutMs = 2 * 60_000;
const probeForgetMs = 60_000;

type ForkOptions = { claudeBin: string; probes: Set<string> };

const inFork = async (
	opts: ForkOptions,
	session: Session,
	args: (forkId: string) => string[],
) => {
	const forkId = randomUUID();
	opts.probes.add(forkId);
	try {
		return await run(
			opts.claudeBin,
			args(forkId),
			session.cwd || undefined,
			askTimeoutMs,
			session.configDir,
		);
	} finally {
		setTimeout(() => opts.probes.delete(forkId), probeForgetMs).unref();
	}
};

export type SessionAsker = (
	session: Session,
	question: string,
) => Promise<Answer>;

export const claudeAsker =
	(opts: ForkOptions): SessionAsker =>
	async (session, question) => {
		const result = await inFork(opts, session, (forkId) =>
			askArgs(session.id, forkId, question),
		);
		return parseAnswer(result.stdout, result.stderr);
	};

export const claudeExitDeps = (
	opts: ForkOptions & { claudeHome: string },
): ExitDeps => {
	const command = async (
		args: string[],
		configDir?: string,
	): Promise<CommandResult> => {
		const result = await run(
			opts.claudeBin,
			args,
			undefined,
			commandTimeoutMs,
			configDir,
		);
		return {
			ok: result.ok,
			output: lastLine(`${result.stdout}\n${result.stderr}`),
		};
	};
	return {
		async ask(session) {
			const result = await inFork(opts, session, (forkId) =>
				readinessArgs(session.id, forkId),
			);
			return parseReadiness(result.stdout, result.stderr);
		},
		stop: (session) =>
			command(["stop", session.short ?? ""], session.configDir),
		remove: (session) =>
			command(["rm", session.short ?? ""], session.configDir),
		async terminate(session) {
			const entry = await liveInteractiveEntry(opts.claudeHome, session);
			if (!entry) {
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
