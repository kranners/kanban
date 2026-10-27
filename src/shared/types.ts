export type SessionKind = "interactive" | "background";

export type Activity =
	| "working"
	| "needs-you"
	| "idle"
	| "done"
	| "failed"
	| "stopped";

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
};

export type Subagent = {
	id: string;
	sessionId: string;
	parentAgentId: string | null;
	type: string;
	description: string;
	live: boolean;
	startedAt: number;
	updatedAt: number;
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

export type Placement = Point & { w?: number; h?: number };

export type Layout = Record<string, Placement>;

export type LayoutUpdate = { key: string; placement: Placement };

export type BoardFeed =
	| { type: "board"; board: Board }
	| { type: "layout"; layout: Layout }
	| { type: "exit"; sessionId: string; result: ExitResult };

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

export type NewSessionResult =
	| { ok: true; short: string }
	| { ok: false; error: string };

export type AttachClientFrame =
	| { t: "in"; d: string }
	| { t: "resize"; cols: number; rows: number };

export type AttachServerNotice =
	| { t: "taken-over" }
	| { t: "exited"; code: number };
