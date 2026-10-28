import type { Artifact } from "./types.ts";

export type PatchHunk = {
	oldStart: number;
	newStart: number;
	lines: string[];
};

export type BackgroundTask = {
	id: string;
	runId: string | null;
	summary: string | null;
	status: string | null;
};

export type ToolResult = {
	text: string;
	isError: boolean;
	images: number;
	truncated: boolean;
	patch: PatchHunk[] | null;
	agentId: string | null;
	answers: Record<string, string> | null;
	interrupted: boolean;
	artifact: Artifact | null;
	task: BackgroundTask | null;
	at: number;
};

type Placed = { index: number; rev: number; at: number };

export type ConversationItem = Placed &
	(
		| { kind: "user"; text: string; images: number; queued: boolean }
		| { kind: "command"; name: string; args: string; output: string }
		| { kind: "assistant"; text: string }
		| { kind: "thinking"; text: string; durationMs: number | null }
		| {
				kind: "tool";
				id: string;
				name: string;
				input: Record<string, unknown>;
				result: ToolResult | null;
		  }
		| { kind: "notice"; level: "info" | "warning" | "error"; text: string }
		| {
				kind: "compaction";
				trigger: string | null;
				preTokens: number | null;
				summary: string | null;
		  }
		| { kind: "interrupted"; forTool: boolean }
		| { kind: "peer"; from: string | null; text: string }
		| { kind: "task"; status: string | null; summary: string }
		| { kind: "rewound" }
	);

export type ConversationStatus = {
	model: string | null;
	cwd: string | null;
	branch: string | null;
	permissionMode: string | null;
	contextTokens: number | null;
	outputTokens: number;
	turnStartedAt: number | null;
	pendingTools: string[];
};

export type AskOption = { label: string; description: string };

export type AskQuestion = {
	question: string;
	header: string;
	multiSelect: boolean;
	options: AskOption[];
};

export type Dialog =
	| {
			kind: "permission";
			toolUseId: string | null;
			title: string;
			context: string | null;
			question: string;
			options: string[];
			complete: boolean;
	  }
	| { kind: "question"; toolUseId: string; questions: AskQuestion[] }
	| { kind: "menu"; title: string };

export type AskAnswer = { selected: string[]; other: string | null };

export type PromptReply = { prompt: string; answers: AskAnswer[] };

export type ViewKey = "Escape" | "Shift+Tab";

export type Drive =
	| { mode: "drive"; via: "cmux" | "attach" }
	| { mode: "read"; reason: string };

export type ConversationClientFrame =
	| { type: "more"; before: number }
	| { type: "prompt"; id: string; text: string }
	| { type: "key"; id: string; key: ViewKey }
	| {
			type: "permission";
			id: string;
			toolUseId: string | null;
			choice: number;
			label: string;
	  }
	| { type: "answer"; id: string; toolUseId: string; answers: AskAnswer[] };

export type ConversationServerFrame =
	| {
			type: "items";
			epoch: string;
			rev: number;
			total: number;
			first: number;
			reset: boolean;
			items: ConversationItem[];
	  }
	| { type: "older"; first: number; items: ConversationItem[] }
	| { type: "status"; status: ConversationStatus }
	| { type: "dialog"; dialog: Dialog | null; answerable: boolean }
	| { type: "mode"; mode: string | null }
	| { type: "drive"; drive: Drive }
	| { type: "done"; id: string; ok: boolean; error: string | null }
	| { type: "ended"; reason: string };

export const maxPromptText = 16_000;
