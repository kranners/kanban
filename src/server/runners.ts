// The hub's view of the owner's machines. Runners register and heartbeat over
// HTTP with the shared token; everything here lives in memory, like the rest
// of the board's view of sessions, and is rebuilt from heartbeats after a
// restart. A machine that stops reporting is offline (or asleep), not an error.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
	parseReportedSubagents,
	reportedSubagent,
} from "../shared/reportedSubagents.ts";
import {
	browseProtocol,
	heartbeatMs,
	jobsProtocol,
	liveRunnerStates,
	maxAllowClasses,
	maxCheckouts,
	offlineAfterMs,
	type PlacedSession,
	pollWaitMs,
	type RunnerAllowList,
	type RunnerCheckout,
	type RunnerCommand,
	type RunnerCommandResult,
	type RunnerHeartbeatReply,
	type RunnerJobResult,
	type RunnerJobsReport,
	type RunnerRegistration,
	type RunnerReport,
	type RunnerSession,
	type RunnerSessionState,
	type RunnerSignals,
	type RunnerSignalsView,
	type RunnerUsage,
	type RunnerView,
	remoteWithoutCredentials,
	runnerIdOf,
	runnerIdOfRunsOn,
	runnerRunsOn,
	signalNames,
} from "../shared/runners.ts";
import type {
	Activity,
	ExitResult,
	FolderBrowse,
	FolderListing,
	NewSessionRequest,
	NewSessionResult,
	Session,
	Subagent,
} from "../shared/types.ts";
import { type JobCandidate, placeJob } from "./jobPlacement.ts";
import type { JobQueue } from "./jobQueue.ts";
import type { DropRecorder } from "./runnerDrops.ts";
import type { RunnerKeys } from "./runnerKeys.ts";
import type { PlacementCandidate } from "./wouldPlace.ts";

export type LocalRunner = {
	name: string;
	usage: RunnerUsage | null;
	signals?: RunnerSignals | null;
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
	/** How long a folder listing may take before the runner counts as not answering. */
	browseTimeoutMs?: number;
	newId?: () => string;
	/** The hub's platform: "This Mac" only names a Mac. */
	platform?: string;
	/** The sha256 of the runner.js the hub serves, told to each runner as it registers. */
	runnerVersion?: () => string | null;
	/** Records each runner's drops by hour of day; none kept when not given. */
	drops?: DropRecorder;
	log?: (line: string) => void;
	/** The durable job queue; no jobs are placed when not given. */
	jobs?: JobQueue;
	/** True while the off-switch file says to offload nothing. */
	jobsOff?: () => boolean;
	/** Runners that never take a personal job, whatever their own config lists. */
	plainOnly?: readonly string[];
	/** Runners told of a new runner.js only after the others ran it cleanly for updateSettleMs. */
	updateLast?: readonly string[];
	updateSettleMs?: number;
	keys?: RunnerKeys;
};

export const updateSettleMs = 10 * 60_000;

export type RunnerHub = {
	register(body: unknown): RunnerRegistration | { ok: false; error: string };
	heartbeat(
		id: string,
		body: unknown,
	): RunnerHeartbeatReply | "unknown" | { error: string };
	/** One attempt's result from the runner that ran it. */
	jobResult(
		id: string,
		jobId: string,
		attempt: number,
		body: unknown,
	): "accepted" | "late" | "unknown" | { error: string };
	/** Hands waiting jobs to runners with room. */
	dispatch(): void;
	poll(id: string, waitMs: number): Promise<RunnerCommand[] | null>;
	requeue(id: string, commands: RunnerCommand[]): void;
	complete(id: string, commandId: string, body: unknown): boolean;
	launch(request: NewSessionRequest): Promise<NewSessionResult>;
	stop(session: Session, force: boolean): Promise<ExitResult>;
	blocker(runsOn: string): string | null;
	/** Lists a folder on a runner's own disk, or says why that machine can't. */
	browse(runsOn: string, path: string | null): Promise<FolderBrowse>;
	/** A runner calling itself this name was turned away for its token. */
	refused(name: string): void;
	/** How the board names its own machine in the pickers. */
	localLabel(): string;
	views(): RunnerView[];
	/** Every machine with its full signals, for the would-place log. */
	candidates(): PlacementCandidate[];
	sessions(): Session[];
	/** The subagents runner sessions report, shaped for the board. */
	subagents(): Subagent[];
	sweep(): void;
	stopAll(): void;
};

type Pending = {
	runnerId: string;
	resolve: (result: RunnerCommandResult) => void;
	timer: NodeJS.Timeout;
	type: RunnerCommand["type"];
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
	/** When a runner of this name last offered a token the hub refused. */
	refusedAt: number | null;
	onlineSince: number | null;
	/** An older runner reads the version only as it registers, so it was sent back to register once. */
	nudged: boolean;
	/** Since when it has run its reported version without dropping. */
	versionSince: number | null;
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

const parseCheckout = (value: unknown): RunnerCheckout | null => {
	if (!isRecord(value)) return null;
	const path = str(value.path, maxString);
	if (!path) return null;
	const raw = value.remote === null ? null : str(value.remote, 1024);
	const remote = raw === null ? null : remoteWithoutCredentials(raw);
	const commit = value.commit === null ? null : str(value.commit, 64);
	return {
		path,
		remote: remote ?? null,
		commit: commit !== null && /^[0-9a-f]{40,64}$/.test(commit) ? commit : null,
	};
};

const classPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const parseAllow = (value: unknown): RunnerAllowList => {
	if (!isRecord(value)) return { classes: [], ceilings: {} };
	const classes = Array.isArray(value.classes)
		? value.classes
				.filter(
					(name): name is string =>
						typeof name === "string" && classPattern.test(name),
				)
				.slice(0, maxAllowClasses)
		: [];
	const ceilings = isRecord(value.ceilings)
		? Object.fromEntries(
				Object.entries(value.ceilings)
					.filter(
						([name, limit]) => classPattern.test(name) && num(limit) !== null,
					)
					.slice(0, maxAllowClasses),
			)
		: {};
	return { classes, ceilings: ceilings as Record<string, number> };
};

const oneOf = <T extends string>(
	value: unknown,
	known: readonly T[],
): T | null => known.find((option) => option === value) ?? null;

const parseWhy = (value: unknown): RunnerSignals["why"] =>
	isRecord(value)
		? Object.fromEntries(
				signalNames.flatMap((name) => {
					const reason = str(value[name], 200);
					return reason ? [[name, reason]] : [];
				}),
			)
		: {};

/** A runner's placement signals; anything malformed reads as unknown, never refuses the report. */
export const parseSignals = (value: unknown): RunnerSignals | undefined => {
	if (!isRecord(value)) return undefined;
	const percent = num(value.batteryPercent);
	return {
		power: oneOf(value.power, ["mains", "battery"] as const),
		batteryPercent: percent !== null && percent <= 100 ? percent : null,
		lidOpen: typeof value.lidOpen === "boolean" ? value.lidOpen : null,
		thermal: oneOf(value.thermal, ["nominal", "throttled"] as const),
		idleSeconds: num(value.idleSeconds),
		sleepMinutes: num(value.sleepMinutes),
		checkouts: Array.isArray(value.checkouts)
			? value.checkouts
					.slice(0, maxCheckouts)
					.map(parseCheckout)
					.filter((checkout) => checkout !== null)
			: [],
		allow: parseAllow(value.allow),
		why: parseWhy(value.why),
	};
};

export const signalsView = (
	signals: RunnerSignals | null | undefined,
): RunnerSignalsView | null => {
	if (!signals) return null;
	const { checkouts, ...rest } = signals;
	return { ...rest, checkoutCount: checkouts.length };
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
	const subagents = parseReportedSubagents(value.subagents);
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
		...(subagents ? { subagents } : {}),
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
	const signals = parseSignals(body.signals);
	const version = str(body.version, 64);
	const jobs = parseJobsReport(body.jobs);
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
		...(signals ? { signals } : {}),
		sessions: sessions as RunnerSession[],
		...(version && /^[0-9a-f]{64}$/.test(version) ? { version } : {}),
		...(jobs ? { jobs } : {}),
	};
};

const jobIdPattern = /^[\w-]{1,64}$/;

export const parseJobsReport = (value: unknown): RunnerJobsReport | null => {
	if (!isRecord(value)) return null;
	const slots = num(value.slotsFree);
	return {
		classes: Array.isArray(value.classes)
			? value.classes
					.filter(isRecord)
					.flatMap((entry) =>
						typeof entry.name === "string" && classPattern.test(entry.name)
							? [{ name: entry.name, personal: entry.personal !== false }]
							: [],
					)
					.slice(0, maxAllowClasses)
			: [],
		refusing:
			value.refusing === null
				? null
				: (str(value.refusing, 200) ?? "unreadable"),
		slotsFree: slots === null ? 0 : Math.floor(slots),
		running: Array.isArray(value.running)
			? value.running
					.filter(isRecord)
					.flatMap((entry) => {
						const attempt = num(entry.attempt);
						return typeof entry.id === "string" &&
							jobIdPattern.test(entry.id) &&
							attempt !== null &&
							Number.isInteger(attempt)
							? [{ id: entry.id, attempt, paused: entry.paused === true }]
							: [];
					})
					.slice(0, 64)
			: [],
	};
};

export const parseJobResult = (value: unknown): RunnerJobResult | null => {
	if (!isRecord(value)) return null;
	const ms = num(value.ms) ?? 0;
	if (value.ok === true) {
		return typeof value.output === "string"
			? { ok: true, output: value.output, ms }
			: null;
	}
	return {
		ok: false,
		error: str(value.error, 400) ?? "The runner failed",
		ms,
		...(value.requeue === true ? { requeue: true } : {}),
		...(value.refused === true ? { refused: true } : {}),
	};
};

const maxFolderName = 255;

export const parseListing = (value: unknown): FolderListing | null => {
	if (!isRecord(value)) return null;
	const machine = str(value.machine, 60);
	const path = str(value.path, maxString);
	const home = str(value.home, maxString);
	const parent = value.parent === null ? null : str(value.parent, maxString);
	const folders = value.folders;
	if (
		machine === null ||
		!path ||
		home === null ||
		(value.parent !== null && parent === null) ||
		!Array.isArray(folders) ||
		folders.length > 1000 ||
		!folders.every(
			(name) =>
				typeof name === "string" &&
				name !== "" &&
				name.length <= maxFolderName &&
				!/[/\p{Cc}]/u.test(name),
		)
	) {
		return null;
	}
	return {
		machine,
		path,
		home,
		parent,
		folders: folders as string[],
		truncated: value.truncated === true,
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
	browseTimeoutMs = 10_000,
	newId = randomUUID,
	platform = process.platform,
	runnerVersion = () => null,
	drops,
	log = () => {},
	jobs,
	jobsOff = () => false,
	plainOnly: plainOnlyNames = [],
	updateLast: updateLastNames = [],
	updateSettleMs: settleMs = updateSettleMs,
	keys,
}: RunnerHubOptions): RunnerHub => {
	const runners = new Map<string, Runner>();
	const pending = new Map<string, Pending>();
	const servingSince = now();
	const plainOnly = plainOnlyNames.map(runnerIdOf);
	const updateLast = updateLastNames.map(runnerIdOf);
	let offSaid = false;

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
		refusedAt: null,
		onlineSince: null,
		versionSince: null,
		nudged: false,
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
		// After a hub restart too, so a drop that spanned it still closes.
		if (!runner.online) {
			drops?.back(runner.id, at, report.bootedAt);
			runner.onlineSince = at;
			runner.versionSince = at;
		}
		if (report.version !== runner.report?.version) runner.versionSince = at;
		drops?.seen(runner.id, at);
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
		if (!runner) return "This machine hasn't checked in yet";
		if (!runner.report) return unreachable(runner);
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
		timeoutMs = commandTimeoutMs,
	): Promise<RunnerCommandResult> =>
		new Promise((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(command.commandId);
				runner.queue = runner.queue.filter(
					(queued) => queued.commandId !== command.commandId,
				);
				resolve({ ok: false, error: `${labelOf(runner)} didn't answer` });
			}, timeoutMs);
			pending.set(command.commandId, {
				runnerId: runner.id,
				resolve,
				timer,
				type: command.type,
			});
			runner.queue.push(command);
			if (runner.waiter) {
				const waiter = runner.waiter;
				runner.waiter = null;
				const commands = deliverable(runner, runner.queue);
				runner.queue = [];
				waiter(commands);
			}
		});

	const localLabel = () => (platform === "darwin" ? "This Mac" : local().name);

	// Why a machine can't look at its own disk right now, in words that say what to do.
	const unreachable = (runner: Runner): string | null => {
		const name = labelOf(runner);
		if (!runner.report) {
			if (runner.refusedAt !== null) {
				return `${name}'s runner offered a token the board refused. Give it the board's KANBAN_RUNNER_TOKEN in ~/.config/kanban/env on ${name}, then restart kanban-runner there.`;
			}
			return `${name}'s runner hasn't connected to the board. On ${name}, put the board's KANBAN_RUNNER_TOKEN in ~/.config/kanban/env and start kanban-runner; its log says why it is waiting.`;
		}
		if (!runner.online) {
			return runner.sleeps
				? `${name} is asleep, so its folders can't be read. Wake it and try again.`
				: `${name}'s runner is offline, so its folders can't be read. Check that ${name} is on and kanban-runner is running there.`;
		}
		if (runner.report.protocol < browseProtocol) {
			return `${name}'s runner is too old to browse folders. Restart kanban-runner on ${name} so it fetches the board's current runner.`;
		}
		return null;
	};

	// An old runner would read a browse as a stop: answer it here instead.
	const deliverable = (
		runner: Runner,
		commands: RunnerCommand[],
	): RunnerCommand[] =>
		commands.filter((command) => {
			if (
				command.type !== "browse" ||
				(runner.report?.protocol ?? 0) >= browseProtocol
			)
				return true;
			const entry = pending.get(command.commandId);
			if (entry) {
				pending.delete(command.commandId);
				clearTimeout(entry.timer);
				entry.resolve({
					ok: false,
					error: `${labelOf(runner)}'s runner is too old to browse folders. Restart kanban-runner on ${labelOf(runner)} so it fetches the board's current runner.`,
				});
			}
			return false;
		});

	const settled = (runner: Runner, version: string, at: number) =>
		runner.report?.version === version &&
		runner.versionSince !== null &&
		at - runner.versionSince >= settleMs;

	// Why a runner updated last isn't told of the runner.js the hub serves yet, or null once it may be.
	const holdBack = (runner: Runner): string | null => {
		const served = runnerVersion();
		if (!served || !updateLast.includes(runner.id)) return null;
		const at = now();
		if (at - servingSince < settleMs) {
			return "updates last, once the board has run this release for 10 minutes";
		}
		const unsettled = [...runners.values()].filter(
			(other) =>
				other !== runner &&
				other.online &&
				other.report?.version !== undefined &&
				!updateLast.includes(other.id) &&
				!settled(other, served, at),
		);
		if (unsettled.length > 0) {
			return `updates last, after ${unsettled.map(labelOf).join(", ")} ran the new runner cleanly for 10 minutes`;
		}
		if ((jobs?.leasesHeldBy(runner.id) ?? 0) > 0) {
			return "updates last, once it holds no job";
		}
		return null;
	};

	const versionFor = (runner: Runner): string | undefined => {
		const served = runnerVersion();
		return served && holdBack(runner) === null ? served : undefined;
	};

	const updateNote = (runner: Runner): string | null => {
		const report = runner.report;
		const served = runnerVersion();
		if (!report || !served || report.version === served) return null;
		if (report.protocol < jobsProtocol) {
			return `${labelOf(runner)} runs an older runner (protocol ${report.protocol}). It updates itself when idle; if it stays on this one, it predates self-update, so restart kanban-runner on ${labelOf(runner)}.`;
		}
		return holdBack(runner) ?? "updates itself once it is idle";
	};

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
		signals: runner.online ? signalsView(runner.report?.signals) : null,
		cap: runner.report?.cap ?? 0,
		sessions: liveOn(runner).map((session) => ({
			id: session.id,
			name: session.name,
			cwd: session.cwd,
			activity: activityOf(session.state, runner.online),
			cpuPercent: runner.online ? session.cpuPercent : null,
			rss: runner.online ? session.rss : null,
		})),
		enrolment: !runner.report
			? "unseen"
			: (keys?.state(runner.id) ?? "shared-token"),
		protocol: runner.report?.protocol ?? null,
		update: updateNote(runner),
		jobs: runner.online ? (runner.report?.jobs ?? null) : null,
	});

	const jobCandidates = (): JobCandidate[] =>
		[...runners.values()].map((runner) => {
			const usage = runner.report?.usage;
			return {
				id: runner.id,
				online: runner.online,
				onlineSince: runner.onlineSince,
				jobs: runner.report?.jobs
					? {
							...runner.report.jobs,
							slotsFree:
								runner.report.jobs.slotsFree -
								Math.max(
									0,
									(jobs?.leasesHeldBy(runner.id) ?? 0) -
										runner.report.jobs.running.length,
								),
						}
					: null,
				plainOnly: plainOnly.includes(runner.id),
				enrolled: keys ? keys.state(runner.id) === "enrolled" : true,
				loadPerCpu:
					usage?.load1 != null && usage.cpus > 0
						? usage.load1 / usage.cpus
						: null,
				drops: drops?.records()[runner.id] ?? null,
			};
		});

	const push = (runner: Runner, command: RunnerCommand) => {
		runner.queue.push(command);
		if (runner.waiter) {
			const waiter = runner.waiter;
			runner.waiter = null;
			const commands = deliverable(runner, runner.queue);
			runner.queue = [];
			waiter(commands);
		}
	};

	const dispatch = () => {
		if (!jobs) return;
		if (jobsOff()) {
			if (!offSaid && jobs.waiting().length > 0) {
				log(
					"jobs: offloading is off (its flag file is present), so nothing is placed",
				);
			}
			offSaid = true;
			return;
		}
		offSaid = false;
		const candidates = jobCandidates();
		for (const waiting of jobs.waiting()) {
			const placed = placeJob(waiting, candidates, now());
			if (!placed.runner) continue;
			const runner = runners.get(placed.runner);
			const job = runner && jobs.lease(waiting.id, runner.id);
			if (!runner || !job) continue;
			const candidate = candidates.find((entry) => entry.id === runner.id);
			if (candidate?.jobs) {
				candidate.jobs = {
					...candidate.jobs,
					slotsFree: candidate.jobs.slotsFree - 1,
				};
			}
			push(runner, { type: "job", commandId: newId(), job });
		}
	};

	const hub: RunnerHub = {
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
			const version = versionFor(runner);
			log(
				`runner ${id} registered: protocol ${report.protocol}, ${report.platform}, ${report.signals ? "with" : "without"} placement signals, ${keys?.state(id) === "enrolled" ? "enrolled" : "on the shared token"}${report.jobs ? `, job classes [${report.jobs.classes.map((entry) => entry.name).join(", ")}]` : ""}`,
			);
			return {
				ok: true,
				id,
				heartbeatMs,
				pollWaitMs,
				...(version ? { runnerVersion: version } : {}),
			};
		},
		heartbeat(id, body) {
			const runner = runners.get(id);
			if (!runner?.report) return "unknown";
			const report = parseRunnerReport(body);
			if (!report) return { error: "Malformed runner report" };
			if (runnerIdOf(report.name) !== id) return "unknown";
			accept(runner, report);
			const stopJobs = jobs?.renew(id, report.jobs?.running ?? []) ?? [];
			dispatch();
			const version = versionFor(runner);
			if (
				version &&
				report.protocol < jobsProtocol &&
				updateLast.includes(id) &&
				!runner.nudged
			) {
				runner.nudged = true;
				return "unknown";
			}
			return {
				ok: true,
				...(version ? { runnerVersion: version } : {}),
				...(stopJobs.length > 0 ? { stopJobs } : {}),
			};
		},
		jobResult(id, jobId, attempt, body) {
			if (!jobs) return "unknown";
			const result = parseJobResult(body);
			if (!result) return { error: "Malformed job result" };
			const outcome = jobs.result(id, jobId, attempt, result);
			if (outcome === "accepted") dispatch();
			return outcome;
		},
		dispatch,
		poll(id, waitMs) {
			const runner = runners.get(id);
			if (!runner?.report) return Promise.resolve(null);
			if (runner.queue.length > 0) {
				const commands = deliverable(runner, runner.queue);
				runner.queue = [];
				if (commands.length > 0) return Promise.resolve(commands);
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
			const listing =
				entry.type === "browse" && isRecord(body) && body.ok === true
					? parseListing(body.listing)
					: undefined;
			const result: RunnerCommandResult =
				isRecord(body) && body.ok === true && listing !== null
					? listing
						? { ok: true, listing }
						: { ok: true }
					: listing === null
						? { ok: false, error: "The runner sent a malformed folder listing" }
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
				return {
					ok: false,
					error: result.error.replace("this machine", labelOf(runner)),
				};
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
		async browse(runsOn, path) {
			const runner = runnerFor(runsOn);
			if (!runner) return { ok: false, error: "No such machine" };
			const blocked = unreachable(runner);
			if (blocked) return { ok: false, error: blocked };
			const result = await send(
				runner,
				{ type: "browse", commandId: newId(), path, hubHome },
				browseTimeoutMs,
			);
			if (!result.ok) return result;
			if (!result.listing) {
				return { ok: false, error: "The runner sent no folder listing" };
			}
			return { ok: true, listing: result.listing };
		},
		refused(name) {
			const id = runnerIdOf(name);
			if (id === "local") return;
			// Only for machines the board expects, so a stranger can't add rows.
			const runner = runners.get(id);
			if (!runner || runner.report) return;
			runner.refusedAt = now();
		},
		localLabel,
		views() {
			const mine = local();
			const own: RunnerView = {
				id: "local",
				name: mine.name,
				label: localLabel(),
				local: true,
				runsOn: "local",
				hostname: mine.name,
				platform,
				state: "online",
				lastSeen: now(),
				goneSince: null,
				usage: mine.usage,
				signals: signalsView(mine.signals),
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
		candidates() {
			const views = hub.views();
			const signalsOf = (runsOn: string): RunnerSignals | null => {
				if (runsOn === "local") return local().signals ?? null;
				const runner = runnerFor(runsOn);
				return runner?.online ? (runner.report?.signals ?? null) : null;
			};
			return views.map((view) => ({ view, signals: signalsOf(view.runsOn) }));
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
		subagents() {
			return [...runners.values()].flatMap((runner) =>
				(runner.report?.sessions ?? []).flatMap((session) =>
					(session.subagents ?? []).map((agent) =>
						reportedSubagent(agent, session.id, runner.online),
					),
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
					drops?.gone(
						runner.id,
						runner.lastSeen,
						runner.report?.bootedAt ?? 0,
						runner.report?.signals,
					);
					runner.waiter?.([]);
					runner.waiter = null;
					changed = true;
				}
			}
			jobs?.sweep();
			dispatch();
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
	return hub;
};
