import type { RegionColours } from "./colours.ts";
import type { ProjectIgnores } from "./ignores.ts";
import type { RunnerView } from "./runners.ts";
import type { SubagentCounts, SubagentState } from "./subagents.ts";

export type SessionKind = "interactive" | "background";

export type FixedRunsOn = "cloud" | "local";

export type RunsOn = FixedRunsOn | `env_${string}` | `runner_${string}`;

export const runsOnChoices: readonly FixedRunsOn[] = ["cloud", "local"];

const remoteHostPattern = /^env_[A-Za-z0-9]+$/;

export const isRemoteHost = (runsOn: string): runsOn is `env_${string}` =>
	remoteHostPattern.test(runsOn);

const runnerPattern = /^runner_[a-z0-9][a-z0-9-]{0,39}$/;

/** A session placed on one of the owner's machines through kanban-runner. */
export const isRunnerTarget = (runsOn: string): runsOn is `runner_${string}` =>
	runnerPattern.test(runsOn);

export type RemoteHost = {
	id: string;
	name: string;
	machine: string;
	directory: string;
};

export const defaultRunsOn: RunsOn = "cloud";

export const isRunsOn = (value: unknown): value is RunsOn =>
	typeof value === "string" &&
	(runsOnChoices.includes(value as FixedRunsOn) ||
		isRemoteHost(value) ||
		isRunnerTarget(value));

/** Where a project's last session from the board ran, and on which account. */
export type LastRun = { runsOn: RunsOn; account?: number };

/** Each project's last run, by its directory. */
export type LastRuns = Record<string, LastRun>;

export type Activity =
	| "working"
	| "needs-you"
	| "watching"
	| "idle"
	| "done"
	| "failed"
	| "stopped";

export const activityOrder: readonly Activity[] = [
	"needs-you",
	"working",
	"watching",
	"idle",
	"done",
	"failed",
	"stopped",
];

export type Artifact = { url: string; title: string; at: number };

export type TaskStatus = "pending" | "in_progress" | "completed";

export type Task = {
	id: string;
	subject: string;
	status: TaskStatus;
	activeForm: string | null;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
};

export type Step = { at: number; text: string };

export type TokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export type Session = {
	id: string;
	short: string | null;
	pid: number | null;
	name: string;
	cwd: string;
	project: string;
	kind: SessionKind;
	activity: Activity;
	doing: string | null;
	needs: string | null;
	goal: string | null;
	startedAt: number;
	updatedAt: number;
	attachable: boolean;
	cmux: boolean;
	artifacts: Artifact[];
	tasks: Task[];
	steps: Step[];
	configDir?: string;
	cloud?: { url: string };
	/** Set when the session runs on another machine through kanban-runner. */
	runner?: { id: string; name: string };
	tokens?: TokenUsage;
};

export type Subagent = {
	id: string;
	kind: "agent" | "shell";
	sessionId: string;
	parentAgentId: string | null;
	type: string;
	description: string;
	live: boolean;
	done: boolean;
	startedAt: number;
	updatedAt: number;
};

export type Workflow = {
	runId: string;
	sessionId: string;
	name: string;
	done: number;
	total: number;
};

export type NodeRef =
	| { kind: "session"; id: string }
	| { kind: "subagent"; id: string };

export type LinkKind = "subagent" | "spawned" | "forked";

export type Link = {
	from: NodeRef;
	to: NodeRef;
	kind: LinkKind;
};

export type Message = {
	id: string;
	from: NodeRef;
	to: NodeRef;
	at: number;
	summary: string;
};

export type Board = {
	sessions: Session[];
	subagents: Subagent[];
	subagentCounts: Record<string, SubagentCounts>;
	subagentStates: Record<string, SubagentState>;
	workflowRuns: Record<string, string[]>;
	workflows: Workflow[];
	links: Link[];
	messages: Message[];
	generatedAt: number;
};

export type TranscriptEntry = {
	at: number;
	role: "user" | "assistant" | "tool" | "peer";
	text: string;
};

export type Point = { x: number; y: number };

export type Placement = Point & { w?: number; h?: number; pinned?: true };

export type Layout = Record<string, Placement>;

export type LayoutUpdate = { key: string; placement: Placement };

export const noteColors = [
	"yellow",
	"pink",
	"green",
	"blue",
	"purple",
	"orange",
] as const;

export type NoteColor = (typeof noteColors)[number];

export const maxNoteText = 20_000;

type Annotated = {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	z: number;
};

export type ReportSectionKey = "done" | "goal" | "left" | "needs";

export type ReportSpan = {
	start: number;
	end: number;
	kind: "done" | "active" | "planned";
	title?: string;
};

export type ReportLane = {
	key: string;
	label: string;
	spans: ReportSpan[];
	finish: number | null;
	events: Step[];
};

export type ReportShot = { url: string; caption: string; at: number };

export type ReportPart = {
	name: string;
	activity: Activity;
	error?: string;
	answer?: string;
	sections: Partial<Record<ReportSectionKey, string>>;
	plan: { ms: number; text: string }[];
	tasks: { done: number; active: number; pending: number };
	burnup: { at: number; done: number }[];
	tokens: TokenUsage | null;
	startedAt: number;
	finish: number | null;
};

export type StatusReport = {
	at: number;
	title: string;
	parts: ReportPart[];
	lanes: ReportLane[];
	shots: ReportShot[];
};

export const maxReportBytes = 400_000;

export type Note = Annotated & {
	kind: "note";
	text: string;
	color: NoteColor;
	session?: string;
	region?: string;
	report?: StatusReport;
	author?: "butler";
};

export type Sticker = Annotated & {
	kind: "sticker";
	sticker: string;
	rotation?: number;
};

export const maxDocTitle = 60;

export type DocStore = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
};

export const butlerCardStates = [
	"working",
	"needs-you",
	"idle",
	"done",
	"failed",
] as const;

export type ButlerCardState = (typeof butlerCardStates)[number];

export const maxButlerTitle = 200;
export const maxButlerSummary = 4000;
export const maxButlerLink = 500;

/**
 * A card Butler, Aaron's assistant bot, keeps on the board: one per
 * change he started (once called a self-fix), or one he made himself. It is an annotation so it
 * saves, drags, resizes and arranges like a note.
 */
export type ButlerCard = Annotated & {
	kind: "butler-card";
	title: string;
	state: ButlerCardState;
	status?: string;
	summary?: string;
	link?: string;
	selfFix?: string;
	watching?: boolean;
	updatedAt: number;
};

export type Annotation = Note | Sticker | ButlerCard;

/** How long Butler's cursor stays on a card after he last acted on it. */
export const butlerPresenceMs = 2 * 60_000;

/** Where Butler is looking on the board, and the sessions he watches. */
export type ButlerPresence = {
	presence: { target: string; label: string; at: number } | null;
	watching: string[];
	/** Whether spike has collected the board's messages lately; absent until it first does. */
	relay?: "up" | "down";
};

export type Annotations = Record<string, Annotation>;

export type RelationEnd = { kind: "session"; id: string };

export type RelationDraft = { from: RelationEnd; to: RelationEnd };

export type Relation = RelationDraft & { id: string; createdAt: number };

export type DocFile = { path: string; size: number; updatedAt: number };

export type DocIndex = Record<string, DocFile[]>;

export type Region = {
	id: string;
	cwd: string;
	name: string | null;
	x: number;
	y: number;
	w: number;
	h: number;
};

export type RegionDraft = Omit<Region, "id" | "name"> & { name?: string };

export type RegionPatch = Partial<Omit<Region, "id" | "cwd">>;

export type CommentEvent =
	| { kind: "user"; at: number; text: string }
	| {
			kind: "action";
			at: number;
			id: string;
			text: string;
			state: "running" | "done" | "failed";
	  }
	| { kind: "reply"; at: number; text: string }
	| { kind: "error"; at: number; text: string };

export type BoardRect = { x: number; y: number; w: number; h: number };

/** What a message to Butler was about, worked out by the board when it was sent. */
export type BoardContext = {
	card?: {
		id: string;
		kind: "session" | "butler-card";
		name: string;
		short?: string;
		state?: string;
		cwd?: string;
	};
	region?: { id: string; name: string; cwd: string };
	viewport?: BoardRect;
};

/** A message to Butler still waiting for spike to take it. */
export type ButlerMessage = { id: string; at: number; text: string };

export const maxButlerQueue = 50;

export type CommentThread = {
	id: string;
	x: number;
	y: number;
	/** Set on every thread with Butler; absent on the retired board agent's, kept to read. */
	to?: "butler";
	context?: BoardContext;
	/** Butler's messages spike has not taken yet, oldest first. */
	queued?: ButlerMessage[];
	/** Ids of messages spike took that Butler has not answered yet. */
	waiting?: string[];
	/** The note Butler's answers are pinned in beside the card it was about. */
	replyNote?: string;
	createdAt: number;
	updatedAt: number;
	resolved: boolean;
	running: boolean;
	sessionId: string;
	resumable: boolean;
	events: CommentEvent[];
};

export type CommentDraft = {
	x: number;
	y: number;
	text: string;
	viewport?: BoardRect;
};

export type CommentPatch = { x?: number; y?: number; resolved?: boolean };

export type UsageWindow = { percent: number; resetsAt: number | null };

export type UsageSample = { at: number; session: number; week: number };

export type AccountUsage = {
	id: string;
	number: number;
	email: string;
	alias: string | null;
	organization: string;
	configDir: string;
	isDefault: boolean;
	session: UsageWindow | null;
	week: UsageWindow | null;
	samples: UsageSample[];
	error: string | null;
	blocked: string | null;
};

export type Usage = {
	session: UsageWindow | null;
	week: UsageWindow | null;
	samples: UsageSample[];
	checkedAt: number | null;
	error: string | null;
	accounts: AccountUsage[];
};

export type AccountResult = { ok: true } | { ok: false; error: string };

export type SessionDigest = {
	at: number;
	now: string;
	progress: string;
	stuck: string | null;
};

export type ProjectDigest = { at: number; narrative: string };

export type Digests = {
	projects: Record<string, ProjectDigest>;
	sessions: Record<string, SessionDigest>;
};

export const noDigests: Digests = { projects: {}, sessions: {} };

export type BoardFeed =
	| { type: "board"; board: Board }
	| { type: "layout"; layout: Layout }
	| { type: "annotations"; annotations: Annotations }
	| { type: "colours"; colours: RegionColours }
	| { type: "last-runs"; lastRuns: LastRuns }
	| { type: "ignores"; ignores: ProjectIgnores }
	| { type: "regions"; regions: Region[] }
	| { type: "exit"; sessionId: string; result: ExitResult }
	| { type: "report"; sessionId: string; result: ReportResult }
	| { type: "region-report"; regionId: string; result: ReportResult }
	| { type: "comments"; comments: CommentThread[] }
	| { type: "comment"; comment: CommentThread }
	| { type: "usage"; usage: Usage }
	| { type: "digests"; digests: Digests }
	| { type: "relations"; relations: Relation[] }
	| { type: "docs"; docs: DocIndex; stores: DocStore[] }
	| { type: "butler"; butler: ButlerPresence }
	| { type: "runners"; runners: RunnerView[] };

export type NewSessionRequest = {
	cwd: string;
	name?: string;
	prompt: string;
	images?: PromptImage[];
	at?: Point;
	account?: number;
	runsOn?: RunsOn;
};

export type PromptImage = { type: string; data: string };

export type ExitRequest = { force: boolean };

export type ExitResult =
	| { ok: true; exited: true }
	| { ok: true; exited: false; reason: string }
	| { ok: false; error: string };

export type ReportResult = { ok: true } | { ok: false; error: string };

export type Landing = { short: string } | { id: string };

export type NewSessionResult =
	| ({ ok: true } & Landing)
	| { ok: false; error: string };

export const landingId = (landing: Landing): string =>
	"short" in landing ? landing.short : landing.id;

export const hasLanded = (landing: Landing, session: Session): boolean =>
	"short" in landing
		? session.short === landing.short
		: session.id === landing.id;

export type AttachClientFrame =
	| { t: "in"; d: string }
	| { t: "resize"; cols: number; rows: number };

export type AttachServerNotice =
	| { t: "taken-over" }
	| { t: "exited"; code: number };

export const mirrorKeys = [
	"Enter",
	"Escape",
	"Tab",
	"Shift+Tab",
	"Up",
	"Down",
	"Backspace",
	"Ctrl+C",
] as const;

export type MirrorKey = (typeof mirrorKeys)[number];

export type MirrorClientFrame =
	| { type: "text"; text: string; submit: boolean }
	| { type: "key"; key: MirrorKey };

export type MirrorServerFrame =
	| { type: "screen"; text: string }
	| { type: "error"; error: string }
	| { type: "ended"; reason: string };

export type FolderPick =
	| { ok: true; path: string }
	| { ok: false; cancelled: true }
	| { ok: false; error: string };
