// The Claude Code sessions a runner carries. Each is a headless
// `claude -p --output-format stream-json` child in the asked-for directory,
// with the prompt on stdin, so nothing user-typed is ever on a command line
// (which matters on Windows, where `claude.cmd` needs a shell).
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import {
	accountName,
	bestAccount,
	continuePrompt,
	cooldownUntil,
	isLimitText,
	maxRunnerMoves,
} from "../shared/failover.ts";
import type {
	RunnerCommandResult,
	RunnerLaunch,
	RunnerSession,
} from "../shared/runners.ts";
import { liveRunnerStates } from "../shared/runners.ts";
import type { AccountUsage } from "../shared/types.ts";

export type ClaudeCommand = { file: string; args: string[] };

/**
 * This machine's cswap accounts, when it has cswap: each session starts on the
 * one with the most headroom and moves to another when it ends on a limit.
 */
export type RunnerAccounts = {
	cswap: string;
	list(): Promise<AccountUsage[] | null>;
};

/** The command that runs claude with these args on an account: cswap run for a profile, plain claude for the default login. */
export const accountSpawn = (
	claude: ClaudeCommand,
	cswap: string,
	account: AccountUsage | null,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } =>
	!account || account.isDefault
		? { file: claude.file, args, env }
		: {
				file: cswap,
				args: ["run", String(account.number), "--share-history", "--", ...args],
				env: isAbsolute(claude.file)
					? {
							...env,
							PATH: [dirname(claude.file), env.PATH]
								.filter(Boolean)
								.join(delimiter),
						}
					: env,
			};

export type SessionManagerOptions = {
	claude: ClaudeCommand;
	platform?: NodeJS.Platform;
	now?: () => number;
	home?: string;
	/** Explicit hub-to-runner directory prefixes, tried before the home mapping. */
	paths?: readonly (readonly [string, string])[];
	isDirectory?: (path: string) => boolean;
	keepFinishedMs?: number;
	maxFinished?: number;
	stopGraceMs?: number;
	accounts?: RunnerAccounts | null;
	onChange?: () => void;
};

export type SessionManager = {
	launch(command: RunnerLaunch): Promise<RunnerCommandResult>;
	stop(sessionId: string, force: boolean): Promise<RunnerCommandResult>;
	list(): RunnerSession[];
	pids(): Map<string, number>;
	stopAll(): Promise<void>;
};

const maxDetail = 160;

const oneLine = (text: string): string | null => {
	const line = text
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part !== "");
	if (!line) return null;
	return line.length > maxDetail ? `${line.slice(0, maxDetail - 1)}…` : line;
};

const isDirectoryOnDisk = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

const under = (path: string, prefix: string): string | null => {
	const trimmed = prefix.replace(/[/\\]+$/, "");
	if (path === trimmed) return "";
	return path.startsWith(`${trimmed}/`) ? path.slice(trimmed.length + 1) : null;
};

type MapOptions = {
	hubHome: string | null;
	home: string;
	paths: readonly (readonly [string, string])[];
	separator?: string;
};

/** Where a hub path may live here: --paths prefixes first, then the home swap. */
export const cwdCandidates = (cwd: string, opts: MapOptions): string[] => {
	const separator = opts.separator ?? sep;
	const candidates: string[] = [];
	for (const [from, to] of opts.paths) {
		const rest = under(cwd, from);
		if (rest !== null)
			candidates.push(rest ? join(to, ...rest.split("/")) : to);
	}
	const rest = opts.hubHome ? under(cwd, opts.hubHome) : null;
	if (rest !== null) {
		candidates.push(
			rest ? [opts.home, ...rest.split("/")].join(separator) : opts.home,
		);
	}
	return candidates;
};

// The hub sends its own path (a Mac's /Users/aaron/code/x). Use it as is when
// it exists here; else map an explicit prefix; else swap the hub's home
// directory for this machine's (/home/aaron/code/x, C:\Users\aaron\code\x).
export const mapCwd = (
	cwd: string,
	opts: MapOptions & { isDirectory: (path: string) => boolean },
): string | null => {
	if (opts.isDirectory(cwd)) return cwd;
	return cwdCandidates(cwd, opts).find(opts.isDirectory) ?? null;
};

export type StreamEvent = {
	sessionId?: string;
	detail?: string;
	result?: { ok: boolean; text: string | null };
};

const toolDetail = (name: string, input: unknown): string => {
	const fields = (input ?? {}) as Record<string, unknown>;
	const hint = [
		fields.description,
		fields.command,
		fields.file_path,
		fields.pattern,
	].find((value): value is string => typeof value === "string");
	return hint ? `${name}: ${hint}` : name;
};

// One line of `--output-format stream-json`: its session id, the latest
// thing said or done, or the final result.
export const readStreamLine = (line: string): StreamEvent | null => {
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof event !== "object" || event === null) return null;
	const sessionId =
		typeof event.session_id === "string" ? event.session_id : undefined;
	if (event.type === "result") {
		const text =
			typeof event.result === "string" ? oneLine(event.result) : null;
		return {
			sessionId,
			result: {
				ok: event.is_error !== true && event.subtype === "success",
				text,
			},
		};
	}
	if (
		event.type === "assistant" &&
		typeof event.parent_tool_use_id === "string"
	)
		// A subagent's step, not the session's own.
		return sessionId ? { sessionId } : null;
	if (event.type === "assistant") {
		const content = (event.message as { content?: unknown } | undefined)
			?.content;
		let detail: string | undefined;
		for (const block of Array.isArray(content) ? content : []) {
			const part = block as Record<string, unknown>;
			if (part.type === "text" && typeof part.text === "string") {
				detail = oneLine(part.text) ?? detail;
			}
			if (part.type === "tool_use" && typeof part.name === "string") {
				detail = oneLine(toolDetail(part.name, part.input)) ?? detail;
			}
		}
		return { sessionId, ...(detail ? { detail } : {}) };
	}
	return sessionId ? { sessionId } : null;
};

type Tracked = {
	session: RunnerSession;
	child: ChildProcess | null;
	stopping: boolean;
	result: { ok: boolean; text: string | null } | null;
	stderr: string;
	account: AccountUsage | null;
	moves: number;
};

export const createSessionManager = ({
	claude,
	platform = process.platform,
	now = Date.now,
	home = homedir(),
	paths = [],
	isDirectory = isDirectoryOnDisk,
	keepFinishedMs = 60 * 60_000,
	maxFinished = 20,
	stopGraceMs = 10_000,
	accounts = null,
	onChange = () => {},
}: SessionManagerOptions): SessionManager => {
	const sessions = new Map<string, Tracked>();
	const windows = platform === "win32";
	const cooldowns: Record<number, number> = {};

	const pick = async (
		exclude: ReadonlySet<number> = new Set(),
	): Promise<{ listed: AccountUsage[]; best: AccountUsage | null } | null> => {
		const listed = accounts ? await accounts.list().catch(() => null) : null;
		if (!listed || listed.length < 2) return null;
		return { listed, best: bestAccount(listed, cooldowns, now(), exclude) };
	};

	/** How often a stream line that changes nothing still counts as the session being heard from. */
	const heardEveryMs = 30_000;
	const touch = (tracked: Tracked, patch: Partial<RunnerSession>) => {
		tracked.session = { ...tracked.session, ...patch, updatedAt: now() };
		onChange();
	};

	const prune = () => {
		const finished = [...sessions.values()]
			.filter(({ session }) => session.endedAt !== null)
			.sort((a, b) => (b.session.endedAt ?? 0) - (a.session.endedAt ?? 0));
		finished.forEach((tracked, index) => {
			if (
				index >= maxFinished ||
				now() - (tracked.session.endedAt ?? 0) > keepFinishedMs
			) {
				sessions.delete(tracked.session.id);
			}
		});
	};

	const kill = (child: ChildProcess, force: boolean) => {
		if (child.pid === undefined) return;
		if (windows) {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			}).on("error", () => {});
			return;
		}
		try {
			// Detached, so the negative pid reaches the whole process group.
			process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
		} catch {
			child.kill(force ? "SIGKILL" : "SIGTERM");
		}
	};

	const failover = async (tracked: Tracked): Promise<boolean> => {
		const resume = tracked.session.claudeSessionId;
		if (!accounts || !resume || tracked.moves >= maxRunnerMoves) return false;
		const listed = await accounts.list().catch(() => null);
		if (!listed || listed.length < 2) return false;
		const from =
			tracked.account ?? listed.find((account) => account.isDefault) ?? null;
		if (from) {
			cooldowns[from.number] = Math.max(
				cooldowns[from.number] ?? 0,
				cooldownUntil(from, now()),
			);
		}
		const to = bestAccount(
			listed,
			cooldowns,
			now(),
			new Set(from ? [from.number] : []),
		);
		const fromName = accountName(from);
		if (!to) {
			tracked.result = {
				ok: false,
				text: `Every Claude account on this machine is at its limit (last on ${fromName}); resume it once one frees up`,
			};
			return false;
		}
		// Stopped from the board while the accounts were read: leave it stopped.
		if (sessions.get(tracked.session.id) !== tracked) return false;
		tracked.moves += 1;
		tracked.result = null;
		tracked.stderr = "";
		const started = spawnClaude(
			tracked,
			to,
			["--resume", resume],
			continuePrompt(fromName, accountName(to)),
		);
		const ok = (await started).ok;
		if (ok) {
			touch(tracked, {
				state: "working",
				detail: `Moved from ${fromName} to ${accountName(to)} (limit)`,
			});
		}
		return ok;
	};

	const finish = (tracked: Tracked, code: number | null) => {
		const limited =
			!tracked.stopping &&
			(isLimitText(tracked.result?.text) ||
				isLimitText(tracked.session.detail));
		if (limited && accounts) {
			tracked.child = null;
			void failover(tracked).then((moved) => {
				if (!moved) settle(tracked, code);
			});
			return;
		}
		settle(tracked, code);
	};

	const settle = (tracked: Tracked, code: number | null) => {
		const { result, stopping, stderr } = tracked;
		tracked.child = null;
		const state = stopping
			? "stopped"
			: result
				? result.ok
					? "done"
					: "failed"
				: code === 0
					? "done"
					: "failed";
		const detail =
			state === "stopped"
				? "Stopped from the board"
				: (result?.text ??
					oneLine(stderr.split("\n").reverse().join("\n")) ??
					(state === "failed" ? `claude exited with code ${code}` : null));
		touch(tracked, {
			state,
			detail: detail ?? tracked.session.detail,
			endedAt: now(),
			cpuPercent: null,
			rss: null,
		});
		prune();
	};

	// Starts (or, with --resume, continues) claude for a tracked session on an account.
	function spawnClaude(
		tracked: Tracked,
		account: AccountUsage | null,
		extra: string[],
		prompt: string,
	): Promise<RunnerCommandResult> {
		return (async (): Promise<RunnerCommandResult> => {
			const run = accountSpawn(claude, accounts?.cswap ?? "cswap", account, [
				...claude.args,
				...extra,
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
			]);
			let child: ChildProcess;
			try {
				child = spawn(run.file, run.args, {
					cwd: tracked.session.localCwd,
					env: run.env,
					stdio: ["pipe", "pipe", "pipe"],
					detached: !windows,
					windowsHide: true,
					shell: windows && !/\.exe$/i.test(run.file),
				});
			} catch (error) {
				return { ok: false, error: `Couldn't start claude: ${error}` };
			}
			const spawned = await new Promise<RunnerCommandResult>((resolve) => {
				child.once("spawn", () => resolve({ ok: true }));
				child.once("error", (error) =>
					resolve({
						ok: false,
						error: `Couldn't start claude: ${error.message}`,
					}),
				);
			});
			if (!spawned.ok) return spawned;
			tracked.child = child;
			tracked.account = account;
			child.on("error", () => {});
			child.stdin?.on("error", () => {});
			child.stdin?.end(prompt);
			let buffered = "";
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				buffered += chunk;
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					const event = readStreamLine(line);
					if (!event) continue;
					if (event.result) tracked.result = event.result;
					const patch: Partial<RunnerSession> = {};
					if (event.sessionId && !tracked.session.claudeSessionId) {
						patch.claudeSessionId = event.sessionId;
					}
					if (event.detail) patch.detail = event.detail;
					if (tracked.session.state === "starting") patch.state = "working";
					if (
						Object.keys(patch).length > 0 ||
						now() - tracked.session.updatedAt >= heardEveryMs
					) {
						touch(tracked, patch);
					}
				}
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				tracked.stderr = (tracked.stderr + chunk).slice(-4096);
			});
			child.on("close", (code) => finish(tracked, code));
			return { ok: true };
		})();
	}

	const launch = async (
		command: RunnerLaunch,
	): Promise<RunnerCommandResult> => {
		const { id, cwd, prompt, name } = command.session;
		if (sessions.has(id)) return { ok: true };
		const localCwd = mapCwd(cwd, {
			hubHome: command.hubHome,
			home,
			paths,
			isDirectory,
		});
		if (localCwd === null) {
			return { ok: false, error: `${cwd} isn't a directory on this machine` };
		}
		const started = now();
		const tracked: Tracked = {
			session: {
				id,
				cwd,
				localCwd,
				name,
				state: "starting",
				detail: null,
				startedAt: started,
				updatedAt: started,
				endedAt: null,
				claudeSessionId: null,
				cpuPercent: null,
				rss: null,
			},
			child: null,
			stopping: false,
			result: null,
			stderr: "",
			account: null,
			moves: 0,
		};
		const placed = await pick();
		tracked.account = placed?.best ?? null;
		const ok = await spawnClaude(tracked, tracked.account, [], prompt);
		if (!ok.ok) return ok;
		sessions.set(id, tracked);
		onChange();
		return { ok: true };
	};

	const stop = async (
		sessionId: string,
		force: boolean,
	): Promise<RunnerCommandResult> => {
		const tracked = sessions.get(sessionId);
		if (!tracked) return { ok: true };
		const { child } = tracked;
		if (!child) {
			// Already ended: stopping it again takes it off the board.
			sessions.delete(sessionId);
			onChange();
			return { ok: true };
		}
		tracked.stopping = true;
		const closed = new Promise<void>((resolve) => child.once("close", resolve));
		kill(child, force);
		const grace = setTimeout(() => kill(child, true), stopGraceMs);
		await closed;
		clearTimeout(grace);
		return { ok: true };
	};

	return {
		launch,
		stop,
		list() {
			prune();
			return [...sessions.values()].map(({ session }) => session);
		},
		pids() {
			const pids = new Map<string, number>();
			for (const { session, child } of sessions.values()) {
				if (
					child?.pid !== undefined &&
					liveRunnerStates.includes(session.state)
				)
					pids.set(session.id, child.pid);
			}
			return pids;
		},
		async stopAll() {
			await Promise.all(
				[...sessions.values()]
					.filter(({ child }) => child !== null)
					.map(({ session }) => stop(session.id, false)),
			);
		},
	};
};
