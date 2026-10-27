import type { RegionColours } from "./colours.ts";
import type { SubagentCounts, SubagentState } from "./subagents.ts";

export type SessionKind = "interactive" | "background";

export type Activity =
	| "working"
	| "needs-you"
	| "idle"
	| "done"
	| "failed"
	| "stopped";

export type Artifact = { url: string; title: string; at: number };

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
};

export type Subagent = {
	id: string;
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

export type Note = Annotated & {
	kind: "note";
	text: string;
	color: NoteColor;
	session?: string;
	region?: string;
};

export type Sticker = Annotated & {
	kind: "sticker";
	sticker: string;
	rotation?: number;
};

export type Annotation = Note | Sticker;

export type Annotations = Record<string, Annotation>;

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

export type CommentThread = {
	id: string;
	x: number;
	y: number;
	createdAt: number;
	updatedAt: number;
	resolved: boolean;
	running: boolean;
	sessionId: string;
	resumable: boolean;
	events: CommentEvent[];
};

export type CommentDraft = { x: number; y: number; text: string };

export type CommentPatch = { x?: number; y?: number; resolved?: boolean };

export type UsageWindow = { percent: number; resetsAt: number | null };

export type UsageSample = { at: number; session: number; week: number };

export type Usage = {
	session: UsageWindow | null;
	week: UsageWindow | null;
	samples: UsageSample[];
	checkedAt: number | null;
	error: string | null;
};

export type BoardFeed =
	| { type: "board"; board: Board }
	| { type: "layout"; layout: Layout }
	| { type: "annotations"; annotations: Annotations }
	| { type: "colours"; colours: RegionColours }
	| { type: "regions"; regions: Region[] }
	| { type: "exit"; sessionId: string; result: ExitResult }
	| { type: "report"; sessionId: string; result: ReportResult }
	| { type: "region-report"; regionId: string; result: ReportResult }
	| { type: "comments"; comments: CommentThread[] }
	| { type: "comment"; comment: CommentThread }
	| { type: "usage"; usage: Usage };

export type NewSessionRequest = {
	cwd: string;
	name?: string;
	prompt: string;
	at?: Point;
};

export type ExitRequest = { force: boolean };

export type ExitResult =
	| { ok: true; exited: true }
	| { ok: true; exited: false; reason: string }
	| { ok: false; error: string };

export type ReportResult = { ok: true } | { ok: false; error: string };

export type NewSessionResult =
	| { ok: true; short: string }
	| { ok: false; error: string };

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
