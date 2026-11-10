// The kanban-runner protocol: what a runner reports to the hub, what the hub
// asks of it, and what the board shows for each machine. Kept free of
// dependencies so the runner bundles to one small file.
import type { ReportedSubagent } from "./reportedSubagents.ts";
import type { Activity, FolderListing, RunsOn } from "./types.ts";

export const runnerProtocol = 3;

/** The first protocol whose runners answer browse commands. */
export const browseProtocol = 2;

/** The first protocol whose runners take job commands and report their own version. */
export const jobsProtocol = 3;

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

/** A git checkout in a folder the runner serves: where, its origin and HEAD, nothing from inside. */
export type RunnerCheckout = {
	path: string;
	remote: string | null;
	commit: string | null;
};

/** The machine's own list of job classes it would take and its ceilings; nothing uses it yet. */
export type RunnerAllowList = {
	classes: string[];
	ceilings: Record<string, number>;
};

export const maxCheckouts = 200;

/** A remote as host and path alone: quotes, user, password, token, query and fragment dropped. */
export const remoteWithoutCredentials = (url: string): string => {
	const bare = url
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.replace(/[?#].*$/, "");
	const scheme = bare.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0];
	if (scheme) {
		const rest = bare.slice(scheme.length);
		const slash = rest.indexOf("/");
		const authority = slash === -1 ? rest : rest.slice(0, slash);
		const path = slash === -1 ? "" : rest.slice(slash);
		return `${scheme}${authority.slice(authority.lastIndexOf("@") + 1)}${path}`;
	}
	const scp = bare.match(/^[^/]*@([^:/]+):(.*)$/);
	return scp ? `git@${scp[1]}:${scp[2]}` : bare;
};
export const maxAllowClasses = 64;

/** What a hub would weigh before placing work here; each null when the platform can't tell. */
export type RunnerSignals = {
	power: "mains" | "battery" | null;
	batteryPercent: number | null;
	lidOpen: boolean | null;
	thermal: "nominal" | "throttled" | null;
	/** Seconds since the last keyboard or mouse input; the counter only, never the input. */
	idleSeconds: number | null;
	/** The system sleep setting in minutes, 0 for never. */
	sleepMinutes: number | null;
	checkouts: RunnerCheckout[];
	allow: RunnerAllowList;
	/** Why each null signal is null. */
	why: Partial<Record<SignalName, string>>;
};

export const signalNames = [
	"power",
	"batteryPercent",
	"lidOpen",
	"thermal",
	"idleSeconds",
	"sleepMinutes",
] as const;

export type SignalName = (typeof signalNames)[number];

/** Signals as the board's feed carries them: the checkouts only counted. */
export type RunnerSignalsView = Omit<RunnerSignals, "checkouts"> & {
	checkoutCount: number;
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
	/** Its own Agent, Task and Workflow calls; absent from runners older than this field. */
	subagents?: ReportedSubagent[];
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
	/** Absent from runners older than placement signals. */
	signals?: RunnerSignals;
	sessions: RunnerSession[];
	/** The sha256 of the runner.js it runs; absent from runners older than jobs. */
	version?: string;
	/** Absent from runners older than jobs. */
	jobs?: RunnerJobsReport;
};

/** A job class as the machine's own config lists it: whether it carries personal data. */
export type RunnerJobClass = { name: string; personal: boolean };

export type RunnerRunningJob = { id: string; attempt: number; paused: boolean };

export type RunnerJobsReport = {
	classes: RunnerJobClass[];
	/** Why the machine takes no new job right now, or null when it would. */
	refusing: string | null;
	slotsFree: number;
	running: RunnerRunningJob[];
};

/** Bytes in, bytes out: run the class's fixed command on the input. */
export type RunnerJob = {
	type: "job";
	commandId: string;
	job: {
		id: string;
		class: string;
		attempt: number;
		/** Epoch ms after which the job is given up. */
		deadline: number;
		/** Base64. */
		input: string;
	};
};

/** What a runner posts back for one attempt of a job. */
export type RunnerJobResult =
	| { ok: true; output: string; ms: number }
	| {
			ok: false;
			error: string;
			ms: number;
			requeue?: boolean;
			refused?: boolean;
	  };

export type RunnerHeartbeatReply = {
	ok: true;
	runnerVersion?: string;
	/** Jobs this runner reported that the hub no longer leases to it: stop them. */
	stopJobs?: string[];
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

/** List a folder on the runner's own disk, for the board's folder browser. */
export type RunnerBrowse = {
	type: "browse";
	commandId: string;
	/** Absolute or starting with ~; null for the machine's workspace folder. */
	path: string | null;
	/** The hub's home directory, so a hub path can be mapped like a launch's. */
	hubHome: string | null;
};

export type RunnerCommand =
	| RunnerLaunch
	| RunnerStop
	| RunnerBrowse
	| RunnerJob;

export type RunnerCommandResult =
	| { ok: true; listing?: FolderListing }
	| { ok: false; error: string };

export type RunnerRegistration = {
	ok: true;
	id: string;
	heartbeatMs: number;
	pollWaitMs: number;
	/** The sha256 of the runner.js the hub serves, so a runner on older code can update itself. */
	runnerVersion?: string;
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
	/** "This Mac" for a hub on a Mac, else its machine name; a runner's name. */
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
	signals?: RunnerSignalsView | null;
	cap: number;
	/** Live sessions placed on it, which count against the cap. */
	sessions: PlacedSession[];
	/** How its last call proved who it is: its own enrolled secret, or the shared token. */
	enrolment?: RunnerEnrolment;
	protocol?: number | null;
	/** Why it is not on the runner the hub serves, when it isn't. */
	update?: string | null;
	jobs?: RunnerJobsReport | null;
};

export type RunnerEnrolment =
	| "enrolled"
	| "shared-token"
	| "cut-off"
	| "unseen";

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
