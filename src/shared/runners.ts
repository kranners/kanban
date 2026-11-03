// The kanban-runner protocol: what a runner reports to the hub, what the hub
// asks of it, and what the board shows for each machine. Kept free of
// dependencies so the runner bundles to one small file.
import type { Activity, RunsOn } from "./types.ts";

export const runnerProtocol = 1;

/** How often a runner reports, and how long the hub waits before calling it gone. */
export const heartbeatMs = 5_000;
export const offlineAfterMs = 15_000;
/** How long a runner's command poll is held open when there is nothing to do. */
export const pollWaitMs = 25_000;

export type RunnerUsage = {
	cpus: number;
	/** Share of all cores busy since the previous sample, 0-100. */
	cpuPercent: number | null;
	/** One-minute load average; null on Windows, which has none. */
	load1: number | null;
	memTotal: number;
	memUsed: number;
	diskTotal: number | null;
	diskFree: number | null;
};

export type RunnerSessionState =
	| "starting"
	| "working"
	| "done"
	| "failed"
	| "stopped";

export const liveRunnerStates: readonly RunnerSessionState[] = [
	"starting",
	"working",
];

export type RunnerSession = {
	/** The hub's id for the session, chosen when it asked for the launch. */
	id: string;
	/** The directory the hub asked for, which keeps the card in its project. */
	cwd: string;
	/** Where it actually runs on the runner, after mapping home directories. */
	localCwd: string;
	name: string;
	state: RunnerSessionState;
	/** The latest thing it said or did, or why it ended. */
	detail: string | null;
	startedAt: number;
	updatedAt: number;
	endedAt: number | null;
	claudeSessionId: string | null;
	cpuPercent: number | null;
	rss: number | null;
};

export type RunnerReport = {
	protocol: number;
	name: string;
	hostname: string;
	platform: string;
	arch: string;
	release: string;
	/** Wall-clock boot time; unchanged across sleep, so a gap with the same boot was sleep. */
	bootedAt: number;
	cap: number;
	usage: RunnerUsage;
	sessions: RunnerSession[];
};

export type RunnerLaunch = {
	type: "launch";
	commandId: string;
	session: { id: string; cwd: string; prompt: string; name: string };
	/** The hub's home directory, so the runner can map it onto its own. */
	hubHome: string | null;
};

export type RunnerStop = {
	type: "stop";
	commandId: string;
	sessionId: string;
	force: boolean;
};

export type RunnerCommand = RunnerLaunch | RunnerStop;

export type RunnerCommandResult = { ok: true } | { ok: false; error: string };

export type RunnerRegistration = {
	ok: true;
	id: string;
	heartbeatMs: number;
	pollWaitMs: number;
};

export type RunnerState = "online" | "offline" | "asleep";

/** A session placed on a machine, as the Runners panel lists it. */
export type PlacedSession = {
	id: string;
	name: string;
	cwd: string;
	activity: Activity;
	cpuPercent: number | null;
	rss: number | null;
};

export type RunnerView = {
	id: string;
	name: string;
	/** "This Mac" for the hub's own machine, else the runner's name. */
	label: string;
	local: boolean;
	runsOn: RunsOn;
	hostname: string | null;
	platform: string | null;
	state: RunnerState;
	/** Last heartbeat; null for a machine expected but not seen since the hub started. */
	lastSeen: number | null;
	/** When it went offline or asleep, while it is. */
	goneSince: number | null;
	usage: RunnerUsage | null;
	cap: number;
	/** Live sessions placed on it, which count against the cap. */
	sessions: PlacedSession[];
};

/** A runner's id from its name: lower case letters, digits and dashes. */
export const runnerIdOf = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "") || "runner";

export const runnerRunsOn = (id: string): `runner_${string}` => `runner_${id}`;

export const runnerIdOfRunsOn = (runsOn: string): string | null =>
	runsOn.startsWith("runner_") ? runsOn.slice("runner_".length) : null;
