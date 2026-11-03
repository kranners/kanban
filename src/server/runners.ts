// The hub's view of the owner's machines. Runners register and heartbeat over
// HTTP with the shared token; everything here lives in memory, like the rest
// of the board's view of sessions, and is rebuilt from heartbeats after a
// restart. A machine that stops reporting is offline (or asleep), not an error.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
	heartbeatMs,
	liveRunnerStates,
	offlineAfterMs,
	type PlacedSession,
	pollWaitMs,
	type RunnerCommand,
	type RunnerCommandResult,
	type RunnerRegistration,
	type RunnerReport,
	type RunnerSession,
	type RunnerSessionState,
	type RunnerUsage,
	type RunnerView,
	runnerIdOf,
	runnerIdOfRunsOn,
	runnerRunsOn,
} from "../shared/runners.ts";
import type {
	Activity,
	ExitResult,
	NewSessionRequest,
	NewSessionResult,
	Session,
} from "../shared/types.ts";

export type LocalRunner = {
	name: string;
	usage: RunnerUsage | null;
	cap: number;
	sessions: PlacedSession[];
};

export type RunnerHubOptions = {
	now?: () => number;
	expected?: readonly string[];
	local: () => LocalRunner;
	hubHome: string | null;
	onChange: () => void;
	offlineMs?: number;
	commandTimeoutMs?: number;
	newId?: () => string;
};

export type RunnerHub = {
	register(body: unknown): RunnerRegistration | { ok: false; error: string };
	heartbeat(id: string, body: unknown): "ok" | "unknown" | { error: string };
	poll(id: string, waitMs: number): Promise<RunnerCommand[] | null>;
	requeue(id: string, commands: RunnerCommand[]): void;
	complete(id: string, commandId: string, body: unknown): boolean;
	launch(request: NewSessionRequest): Promise<NewSessionResult>;
	stop(session: Session, force: boolean): Promise<ExitResult>;
	blocker(runsOn: string): string | null;
	views(): RunnerView[];
	sessions(): Session[];
	sweep(): void;
	stopAll(): void;
};

type Pending = {
	runnerId: string;
	resolve: (result: RunnerCommandResult) => void;
	timer: NodeJS.Timeout;
};

type Runner = {
	id: string;
	report: RunnerReport | null;
	lastSeen: number | null;
	goneSince: number | null;
	online: boolean;
	/** The last silence ended with the same boot time, so it was sleep. */
	sleeps: boolean;
	queue: RunnerCommand[];
	waiter: ((commands: RunnerCommand[]) => void) | null;
	/** Sessions asked for but not yet in a heartbeat. */
	launching: Map<string, RunnerSession>;
};

const maxString = 4096;
const maxSessions = 200;
const bootSlackMs = 2 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown, limit = 200): string | null =>
	typeof value === "string" && value.length <= limit ? value : null;

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;

const sessionStates: readonly RunnerSessionState[] = [
	"starting",
	"working",
	"done",
	"failed",
	"stopped",
];

const parseUsage = (value: unknown): RunnerUsage | null => {
	if (!isRecord(value)) return null;
	const cpus = num(value.cpus);
	const memTotal = num(value.memTotal);
	const memUsed = num(value.memUsed);
	if (cpus === null || memTotal === null || memUsed === null) return null;
	return {
		cpus,
		cpuPercent: num(value.cpuPercent),
		load1: num(value.load1),
		memTotal,
		memUsed: Math.min(memUsed, memTotal),
		diskTotal: num(value.diskTotal),
		diskFree: num(value.diskFree),
	};
};

const parseSession = (value: unknown): RunnerSession | null => {
	if (!isRecord(value)) return null;
	const id = str(value.id, 64);
	const cwd = str(value.cwd, maxString);
	const localCwd = str(value.localCwd, maxString);
	const name = str(value.name, 200);
	const state = sessionStates.find((known) => known === value.state);
	const startedAt = num(value.startedAt);
	const updatedAt = num(value.updatedAt);
	if (
		!id ||
		!/^[\w-]{1,64}$/.test(id) ||
		cwd === null ||
		localCwd === null ||
		name === null ||
		!state ||
		startedAt === null ||
		updatedAt === null
	) {
		return null;
	}
	return {
		id,
		cwd,
		localCwd,
		name,
		state,
		detail: str(value.detail, 400),
		startedAt,
		updatedAt,
		endedAt: num(value.endedAt),
		claudeSessionId: str(value.claudeSessionId, 128),
		cpuPercent: num(value.cpuPercent),
		rss: num(value.rss),
	};
};

export const parseRunnerReport = (body: unknown): RunnerReport | null => {
	if (!isRecord(body)) return null;
	const name = str(body.name, 60)?.trim();
	const usage = parseUsage(body.usage);
	const cap = num(body.cap);
	if (
		!name ||
		!usage ||
		cap === null ||
		!Number.isInteger(cap) ||
		!Array.isArray(body.sessions) ||
		body.sessions.length > maxSessions
	) {
		return null;
	}
	const sessions = body.sessions.map(parseSession);
	if (sessions.some((session) => session === null)) return null;
	return {
		protocol: num(body.protocol) ?? 0,
		name,
		hostname: str(body.hostname) ?? name,
		platform: str(body.platform, 32) ?? "unknown",
		arch: str(body.arch, 32) ?? "",
		release: str(body.release, 100) ?? "",
		bootedAt: num(body.bootedAt) ?? 0,
		cap,
		usage,
		sessions: sessions as RunnerSession[],
	};
};

const activityOf = (state: RunnerSessionState, online: boolean): Activity => {
	if (!online && liveRunnerStates.includes(state)) return "idle";
	switch (state) {
		case "starting":
		case "working":
			return "working";
		case "done":
			return "done";
		case "failed":
			return "failed";
		case "stopped":
			return "stopped";
	}
};

export const createRunnerHub = ({
	now = Date.now,
	expected = [],
	local,
	hubHome,
	onChange,
	offlineMs = offlineAfterMs,
	commandTimeoutMs = 60_000,
	newId = randomUUID,
}: RunnerHubOptions): RunnerHub => {
	const runners = new Map<string, Runner>();
	const pending = new Map<string, Pending>();

	const blank = (id: string): Runner => ({
		id,
		report: null,
		lastSeen: null,
		goneSince: null,
		online: false,
		sleeps: false,
		queue: [],
		waiter: null,
		launching: new Map(),
	});

	for (const name of expected) {
		const id = runnerIdOf(name);
		if (id !== "local" && !runners.has(id)) runners.set(id, blank(id));
	}

	const sessionsOf = (runner: Runner): RunnerSession[] => {
		const reported = runner.report?.sessions ?? [];
		const known = new Set(reported.map((session) => session.id));
		return [
			...reported,
			...[...runner.launching.values()].filter(
				(session) => !known.has(session.id),
			),
		];
	};

	const liveOn = (runner: Runner) =>
		sessionsOf(runner).filter((session) =>
			liveRunnerStates.includes(session.state),
		);

	const accept = (runner: Runner, report: RunnerReport) => {
		const at = now();
		if (!runner.online && runner.report) {
			runner.sleeps =
				Math.abs(report.bootedAt - runner.report.bootedAt) <= bootSlackMs;
		}
		runner.report = report;
		runner.lastSeen = at;
		runner.online = true;
		runner.goneSince = null;
		for (const session of report.sessions) runner.launching.delete(session.id);
		onChange();
	};

	const runnerFor = (runsOn: string): Runner | null => {
		const id = runnerIdOfRunsOn(runsOn);
		return id === null ? null : (runners.get(id) ?? null);
	};

	const labelOf = (runner: Runner) => runner.report?.name ?? runner.id;

	const blockerOf = (runner: Runner | null): string | null => {
		if (!runner?.report) return "This machine hasn't checked in yet";
		if (!runner.online) {
			return `${labelOf(runner)} is ${runner.sleeps ? "asleep" : "offline"}`;
		}
		const live = liveOn(runner).length;
		return live >= runner.report.cap
			? `${labelOf(runner)} is at its cap (${live} of ${runner.report.cap})`
			: null;
	};

	const send = (
		runner: Runner,
		command: RunnerCommand,
	): Promise<RunnerCommandResult> =>
		new Promise((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(command.commandId);
				runner.queue = runner.queue.filter(
					(queued) => queued.commandId !== command.commandId,
				);
				resolve({ ok: false, error: `${labelOf(runner)} didn't answer` });
			}, commandTimeoutMs);
			pending.set(command.commandId, { runnerId: runner.id, resolve, timer });
			runner.queue.push(command);
			if (runner.waiter) {
				const waiter = runner.waiter;
				runner.waiter = null;
				const commands = runner.queue;
				runner.queue = [];
				waiter(commands);
			}
		});

	const viewOf = (runner: Runner): RunnerView => ({
		id: runner.id,
		name: labelOf(runner),
		label: labelOf(runner),
		local: false,
		runsOn: runnerRunsOn(runner.id),
		hostname: runner.report?.hostname ?? null,
		platform: runner.report?.platform ?? null,
		state: runner.online ? "online" : runner.sleeps ? "asleep" : "offline",
		lastSeen: runner.lastSeen,
		goneSince: runner.online ? null : (runner.goneSince ?? null),
		usage: runner.online ? (runner.report?.usage ?? null) : null,
		cap: runner.report?.cap ?? 0,
		sessions: liveOn(runner).map((session) => ({
			id: session.id,
			name: session.name,
			cwd: session.cwd,
			activity: activityOf(session.state, runner.online),
			cpuPercent: runner.online ? session.cpuPercent : null,
			rss: runner.online ? session.rss : null,
		})),
	});

	return {
		register(body) {
			const report = parseRunnerReport(body);
			if (!report) return { ok: false, error: "Malformed runner report" };
			const id = runnerIdOf(report.name);
			if (id === "local") {
				return { ok: false, error: '"local" is the hub\'s own name' };
			}
			const runner = runners.get(id) ?? blank(id);
			runners.set(id, runner);
			accept(runner, report);
			return { ok: true, id, heartbeatMs, pollWaitMs };
		},
		heartbeat(id, body) {
			const runner = runners.get(id);
			if (!runner?.report) return "unknown";
			const report = parseRunnerReport(body);
			if (!report) return { error: "Malformed runner report" };
			if (runnerIdOf(report.name) !== id) return "unknown";
			accept(runner, report);
			return "ok";
		},
		poll(id, waitMs) {
			const runner = runners.get(id);
			if (!runner?.report) return Promise.resolve(null);
			if (runner.queue.length > 0) {
				const commands = runner.queue;
				runner.queue = [];
				return Promise.resolve(commands);
			}
			runner.waiter?.([]);
			return new Promise((resolve) => {
				const timer = setTimeout(
					() => {
						if (runner.waiter === finish) runner.waiter = null;
						resolve([]);
					},
					Math.max(0, Math.min(waitMs, pollWaitMs)),
				);
				const finish = (commands: RunnerCommand[]) => {
					clearTimeout(timer);
					resolve(commands);
				};
				runner.waiter = finish;
			});
		},
		requeue(id, commands) {
			const runner = runners.get(id);
			if (!runner) return;
			const live = commands.filter((command) => pending.has(command.commandId));
			runner.queue = [...live, ...runner.queue];
		},
		complete(id, commandId, body) {
			const entry = pending.get(commandId);
			if (!entry || entry.runnerId !== id) return false;
			pending.delete(commandId);
			clearTimeout(entry.timer);
			const result: RunnerCommandResult =
				isRecord(body) && body.ok === true
					? { ok: true }
					: {
							ok: false,
							error:
								(isRecord(body) && str(body.error, 400)) ||
								"The runner refused",
						};
			entry.resolve(result);
			return true;
		},
		async launch(request) {
			const runner = runnerFor(request.runsOn ?? "");
			const blocked = blockerOf(runner);
			if (blocked || !runner) {
				return { ok: false, error: blocked ?? "No such machine" };
			}
			const id = newId();
			const name = request.name ?? basename(request.cwd);
			const startedAt = now();
			runner.launching.set(id, {
				id,
				cwd: request.cwd,
				localCwd: request.cwd,
				name,
				state: "starting",
				detail: null,
				startedAt,
				updatedAt: startedAt,
				endedAt: null,
				claudeSessionId: null,
				cpuPercent: null,
				rss: null,
			});
			const result = await send(runner, {
				type: "launch",
				commandId: newId(),
				session: { id, cwd: request.cwd, prompt: request.prompt, name },
				hubHome,
			});
			if (!result.ok) {
				runner.launching.delete(id);
				onChange();
				return result;
			}
			onChange();
			return { ok: true, id };
		},
		async stop(session, force) {
			const runner = session.runner ? runners.get(session.runner.id) : null;
			if (!runner) return { ok: false, error: "No such machine" };
			if (!runner.online) {
				return {
					ok: false,
					error: `${labelOf(runner)} is ${runner.sleeps ? "asleep" : "offline"}`,
				};
			}
			const result = await send(runner, {
				type: "stop",
				commandId: newId(),
				sessionId: session.id,
				force,
			});
			return result.ok ? { ok: true, exited: true } : result;
		},
		blocker(runsOn) {
			return blockerOf(runnerFor(runsOn));
		},
		views() {
			const mine = local();
			const own: RunnerView = {
				id: "local",
				name: mine.name,
				label: "This Mac",
				local: true,
				runsOn: "local",
				hostname: mine.name,
				platform: process.platform,
				state: "online",
				lastSeen: now(),
				goneSince: null,
				usage: mine.usage,
				cap: mine.cap,
				sessions: mine.sessions,
			};
			const rank = (view: RunnerView) => (view.state === "online" ? 0 : 1);
			return [
				own,
				...[...runners.values()]
					.map(viewOf)
					.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)),
			];
		},
		sessions() {
			return [...runners.values()].flatMap((runner) =>
				sessionsOf(runner).map(
					(session): Session => ({
						id: session.id,
						short: null,
						pid: null,
						name: session.name,
						cwd: session.cwd,
						project: basename(session.cwd),
						kind: "background",
						activity: activityOf(session.state, runner.online),
						doing: runner.online
							? session.detail
							: `${labelOf(runner)} is ${runner.sleeps ? "asleep" : "offline"}`,
						needs: null,
						goal: session.name,
						startedAt: session.startedAt,
						updatedAt: session.updatedAt,
						attachable: false,
						cmux: false,
						artifacts: [],
						tasks: [],
						steps: [],
						runner: { id: runner.id, name: labelOf(runner) },
					}),
				),
			);
		},
		sweep() {
			const at = now();
			let changed = false;
			for (const runner of runners.values()) {
				if (
					runner.online &&
					runner.lastSeen !== null &&
					at - runner.lastSeen > offlineMs
				) {
					runner.online = false;
					runner.goneSince = runner.lastSeen;
					runner.waiter?.([]);
					runner.waiter = null;
					changed = true;
				}
			}
			if (changed) onChange();
		},
		stopAll() {
			for (const runner of runners.values()) {
				runner.waiter?.([]);
				runner.waiter = null;
			}
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.resolve({ ok: false, error: "The board is shutting down" });
			}
			pending.clear();
		},
	};
};
