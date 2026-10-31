import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type CommentEvent,
	type CommentThread,
	maxNoteText,
} from "../shared/types.ts";
import type { AgentTokens } from "./agentAuth.ts";
import {
	type AgentStreamEvent,
	lineSplitter,
	parseStreamLine,
} from "./agentStream.ts";
import type { CommentStore } from "./comments.ts";
import { lastLine, truncate } from "./ingest/json.ts";

export type AgentProcess = Pick<
	ChildProcess,
	"stdout" | "stderr" | "kill" | "on"
>;

export type SpawnAgent = (
	args: string[],
	env: NodeJS.ProcessEnv,
) => AgentProcess;

export type BoardAgent = {
	ask(
		threadId: string,
		text: string,
	): { ok: true } | { error: string; status: 404 | 409 };
	cancel(threadId: string): boolean;
	stopAll(): void;
	owns(sessionId: string): boolean;
};

export type BoardAgentDeps = {
	store: CommentStore;
	tokens: AgentTokens;
	spawn: SpawnAgent;
	boardUrl: string;
	mcpScript: string;
	node: string;
	timeoutMs: number;
	maxRuns?: number;
};

export const boardAgentPrompt = `You are the board agent of kanban, a whiteboard of the user's Claude Code sessions on this Mac. The user pinned a comment on the board, or pressed a button in its top bar, and you act on it on their behalf, using only the mcp__kanban__ tools.

The board:
- Coordinates are board pixels; x grows right and y grows down. Everything snaps to a 24px grid.
- Session cards are 312x240 by default (resizable from 240x168 to 960x720); subagent cards are 216x72 and sit below their session unless moved. A card's x and y are its top-left corner.
- A project region is a named frame for one directory. A session belongs to a region when its cwd is inside the region's directory and its card centre lies inside the frame. Leave about 24px of padding and 32px above the cards for the label. Moving a region does not move its cards: move them in the same arrange call.
- Notes render GitHub-flavoured markdown (headings, lists, task lists, tables, code) and hold at most ${maxNoteText} characters. A new note without w and h is sized to its text; place it near the comment (thisComment in board_snapshot) or the session it is about, in free space.
- Stickers are Twemoji by id; find them with find_stickers.

How to work:
- Start with board_snapshot. Prefer few, batched calls: one arrange call can move every card, region and note.
- To organise the board into projects, group sessions by cwd (or a shared parent directory), create one region per project sized to hold its cards in a tidy grid, then arrange the cards inside, keeping regions apart.
- For a report on a session, read its transcript and ask it if you need more, then write a concise, well-structured markdown note.
- ask_session answers from a throwaway copy of the session and is safe. send_prompt types into the real session: use it only when the user asked you to tell a session something. announce sends one message to every live session at once, even working ones: use it only when the user asked to tell every session something, and report the sessions it skipped. When a session waits on a question or permission prompt, send_prompt refuses: read the prompt with answer_prompt, match what the user said to one of its options, and answer with that and the prompt id the read returned. Never pick an answer the user did not choose; if their choice is ambiguous, say so instead. finish_session asks the session first and only ends it if it agrees; you can never force a session to exit, and must not try to work around a refusal.
- Never delete or move things the user did not ask about.
- Finish with a short plain summary of what you did (one to three sentences), or the answer the user asked for.`;

export const mcpConfig = (node: string, script: string, boardUrl: string) =>
	JSON.stringify({
		mcpServers: {
			kanban: {
				type: "stdio",
				command: node,
				args: [script],
				env: { KANBAN_AGENT_URL: boardUrl },
			},
		},
	});

export const agentArgs = (
	thread: Pick<CommentThread, "sessionId" | "resumable">,
	text: string,
	config: string,
): string[] => [
	"-p",
	"--output-format",
	"stream-json",
	"--verbose",
	...(thread.resumable
		? ["--resume", thread.sessionId]
		: ["--session-id", thread.sessionId]),
	"--tools",
	"",
	"--strict-mcp-config",
	"--mcp-config",
	config,
	"--allowedTools",
	"mcp__kanban",
	"--permission-mode",
	"dontAsk",
	"--settings",
	JSON.stringify({ disableAllHooks: true }),
	"--disable-slash-commands",
	"--append-system-prompt",
	boardAgentPrompt,
	"--",
	text,
];

const toolTitles: Record<string, string> = {
	board_snapshot: "Looking at the board",
	read_transcript: "Reading a transcript",
	ask_session: "Asking a session",
	send_prompt: "Sending a prompt",
	announce: "Announcing to every session",
	answer_prompt: "Answering a prompt",
	finish_session: "Finishing a session",
	start_session: "Starting a session",
	put_note: "Writing a note",
	put_sticker: "Placing a sticker",
	delete_annotations: "Deleting notes and stickers",
	find_stickers: "Finding stickers",
	arrange: "Arranging the board",
	create_region: "Drawing a region",
	update_region: "Changing a region",
	delete_region: "Deleting a region",
};

const mcpPrefix = "mcp__kanban__";

export const actionTitle = (tool: string): string =>
	toolTitles[
		tool.startsWith(mcpPrefix) ? tool.slice(mcpPrefix.length) : tool
	] ?? tool;

const resultLine = (text: string): string =>
	truncate(text.split("\n")[0]?.trim() || "Done", 200);

export const applyStreamEvent = (
	thread: CommentThread,
	event: AgentStreamEvent,
	at: number,
): CommentThread => {
	const add = (added: CommentEvent) => ({
		...thread,
		events: [...thread.events, added],
	});
	switch (event.kind) {
		case "init":
			return { ...thread, resumable: true };
		case "text":
			return add({ kind: "reply", at, text: event.text });
		case "tool-start":
			return add({
				kind: "action",
				at,
				id: event.id,
				text: actionTitle(event.name),
				state: "running",
			});
		case "tool-end":
			return {
				...thread,
				events: thread.events.map((item) =>
					item.kind === "action" && item.id === event.id
						? {
								...item,
								text: event.isError
									? `${item.text} failed: ${resultLine(event.text)}`
									: resultLine(event.text),
								state: event.isError ? "failed" : "done",
							}
						: item,
				),
			};
		case "result":
			return event.isError
				? add({
						kind: "error",
						at,
						text: event.text || "The agent stopped with an error",
					})
				: thread;
	}
};

const settled = (thread: CommentThread): CommentThread => ({
	...thread,
	running: false,
	events: thread.events.map((event) =>
		event.kind === "action" && event.state === "running"
			? { ...event, state: "failed" }
			: event,
	),
});

export const createBoardAgent = (deps: BoardAgentDeps): BoardAgent => {
	const runs = new Map<string, AgentProcess>();
	const cancelling = new Set<string>();
	const maxRuns = deps.maxRuns ?? 4;
	const config = mcpConfig(deps.node, deps.mcpScript, deps.boardUrl);

	const note = (threadId: string, event: CommentEvent) =>
		deps.store.update(threadId, (thread) => ({
			...thread,
			events: [...thread.events, event],
		}));

	const halt = (threadId: string, reason: string): boolean => {
		const child = runs.get(threadId);
		if (!child) return false;
		cancelling.add(threadId);
		note(threadId, { kind: "error", at: Date.now(), text: reason });
		child.kill("SIGTERM");
		return true;
	};

	const start = (thread: CommentThread, text: string) => {
		const token = deps.tokens.issue(thread.id);
		const child = deps.spawn(agentArgs(thread, text, config), {
			...process.env,
			KANBAN_AGENT_TOKEN: token,
		});
		runs.set(thread.id, child);
		let finished = false;
		let errors = "";
		let cancelled = false;
		const timer = setTimeout(() => {
			cancelled = true;
			note(thread.id, {
				kind: "error",
				at: Date.now(),
				text: "The agent took too long and was stopped",
			});
			child.kill("SIGTERM");
		}, deps.timeoutMs);
		const lines = lineSplitter((line) => {
			for (const event of parseStreamLine(line)) {
				if (event.kind === "result") finished = true;
				deps.store.update(thread.id, (current) =>
					applyStreamEvent(current, event, Date.now()),
				);
			}
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => lines.push(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			errors = (errors + chunk).slice(-4000);
		});
		const end = (code: number | null, failure?: Error) => {
			if (runs.get(thread.id) !== child) return;
			runs.delete(thread.id);
			clearTimeout(timer);
			deps.tokens.revoke(token);
			lines.flush();
			const stopped = cancelling.delete(thread.id) || cancelled;
			if (!finished && !stopped) {
				const detail = failure?.message ?? lastLine(errors);
				note(thread.id, {
					kind: "error",
					at: Date.now(),
					text: detail
						? `The agent stopped: ${detail}`
						: `The agent stopped (exit code ${code ?? "none"})`,
				});
			}
			deps.store.update(thread.id, settled);
		};
		child.on("exit", (code) => end(code));
		child.on("error", (error) => end(null, error));
	};

	return {
		ask(threadId, text) {
			const thread = deps.store.get(threadId);
			if (!thread) return { error: "No such comment", status: 404 };
			if (runs.has(threadId)) {
				return {
					error: "The agent is still working on this thread",
					status: 409,
				};
			}
			if (runs.size >= maxRuns) {
				return {
					error: `At most ${maxRuns} board agents run at once`,
					status: 409,
				};
			}
			const updated = deps.store.update(threadId, (current) => ({
				...current,
				running: true,
				resolved: false,
				events: [...current.events, { kind: "user", at: Date.now(), text }],
			}));
			if (updated) start(updated, text);
			return { ok: true };
		},
		cancel: (threadId) => halt(threadId, "Cancelled"),
		stopAll() {
			for (const threadId of [...runs.keys()]) {
				halt(threadId, "The board server stopped, so this run was stopped");
			}
		},
		owns: deps.store.owns,
	};
};

export const agentMarker = ".kanban-board-agent";

export const isAgentDir = (cwd: string): boolean =>
	existsSync(join(cwd, agentMarker));

export const claudeAgentSpawner =
	(claudeBin: string, cwd: string): SpawnAgent =>
	(args, env) =>
		spawn(claudeBin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
