import type {
	Artifact,
	Step,
	Task,
	TaskStatus,
	TokenUsage,
	TranscriptEntry,
} from "../../shared/types.ts";
import { publishedArtifact } from "../artifacts.ts";
import {
	asNumber,
	asObject,
	asString,
	asTime,
	firstLine,
	type Json,
	lastLine,
	truncate,
} from "./json.ts";

export type PeerRef = { pid?: number; socket?: string; name?: string };

export type ResolvePeer = (ref: PeerRef) => string | null;

export type SentMessage = {
	at: number;
	summary: string;
	to: string | null;
};

export type ReceivedMessage = {
	at: number;
	summary: string;
	from: string | null;
};

export type Handback = { agentId: string; at: number; summary: string };

export type BackgroundShell = {
	tool: "Bash" | "Monitor";
	description: string;
	startedAt: number;
	endedAt: number | null;
};

export type TranscriptFacts = {
	doing: string | null;
	aiTitle: string | null;
	lastPrompt: string | null;
	lastAt: number;
	tools: Map<string, { name: string; input: Json }>;
	sent: Map<string, SentMessage>;
	received: Map<string, ReceivedMessage>;
	handbacks: Handback[];
	spawnedShorts: Set<string>;
	forkedChildren: Set<string>;
	finishedTasks: Set<string>;
	shells: Map<string, BackgroundShell>;
	workflowRuns: Map<string, string>;
	workflowNames: Map<string, string>;
	artifacts: Map<string, Artifact>;
	tasks: Map<string, Task>;
	steps: Step[];
	entries: TranscriptEntry[];
	tokens: TokenUsage;
	countedMessages: Set<string>;
};

export const entryLimit = 2000;
const handbackLimit = 200;
export const stepLimit = 40;
const summaryLength = 80;
const entryTextLength = 4000;
const backgroundedPattern = /backgrounded · ([0-9a-f]{8})/g;
const taskIdPattern = /<task-id>([^<\s]+)<\/task-id>/g;

export function createFacts(): TranscriptFacts {
	return {
		doing: null,
		aiTitle: null,
		lastPrompt: null,
		lastAt: 0,
		tools: new Map(),
		sent: new Map(),
		received: new Map(),
		handbacks: [],
		spawnedShorts: new Set(),
		forkedChildren: new Set(),
		finishedTasks: new Set(),
		shells: new Map(),
		workflowRuns: new Map(),
		workflowNames: new Map(),
		artifacts: new Map(),
		tasks: new Map(),
		steps: [],
		entries: [],
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		countedMessages: new Set(),
	};
}

export function summariseTool(name: string, input: Json): string {
	const detail = [
		input.description,
		input.file_path,
		input.command,
		input.pattern,
	].find((value): value is string => typeof value === "string" && value !== "");
	return truncate(
		detail ? `${name}: ${firstLine(detail)}` : name,
		summaryLength,
	);
}

export function peerRefFromAddress(address: string): PeerRef {
	return address.startsWith("uds:")
		? { socket: address.slice(4) }
		: { name: address };
}

export function applyRecord(
	facts: TranscriptFacts,
	value: unknown,
	resolve: ResolvePeer,
): void {
	const record = asObject(value);
	if (!record || isInheritedFromFork(record)) return;
	const at = asTime(record.timestamp) ?? 0;
	if (at > facts.lastAt) facts.lastAt = at;
	switch (record.type) {
		case "assistant":
			applyAssistant(facts, record, at);
			return;
		case "user":
			applyUser(facts, record, at, resolve);
			return;
		case "queue-operation":
			collectFinishedTasks(facts, asString(record.content) ?? "", at);
			return;
		case "attachment": {
			const attachment = asObject(record.attachment);
			if (attachment?.type === "queued_command") {
				collectFinishedTasks(facts, asString(attachment.prompt) ?? "", at);
			}
			return;
		}
		case "ai-title":
			facts.aiTitle = asString(record.aiTitle)?.trim() || facts.aiTitle;
			return;
		case "last-prompt":
			facts.lastPrompt =
				humanGoal(asString(record.lastPrompt)) ?? facts.lastPrompt;
			return;
		case "continued-in": {
			const child = asString(record.continuedInSessionId);
			if (child) facts.forkedChildren.add(child);
			return;
		}
	}
}

function isInheritedFromFork(record: Json): boolean {
	return (
		typeof record.session_id === "string" &&
		typeof record.sessionId === "string" &&
		record.session_id !== record.sessionId
	);
}

const relayedPrompts = [
	"!",
	"<",
	"Another Claude session sent a message:",
	"[Artifact comment sent to Claude]",
];

function humanGoal(prompt: string | null): string | null {
	const text = prompt?.replace(/^(\[Image #\d+\]\s*)+/, "").trim();
	if (!text || relayedPrompts.some((prefix) => text.startsWith(prefix)))
		return null;
	return text;
}

function applyAssistant(facts: TranscriptFacts, record: Json, at: number) {
	const message = asObject(record.message);
	countTokens(facts, message);
	const content = message?.content;
	if (!Array.isArray(content)) return;
	for (const item of content) {
		const block = asObject(item);
		if (!block) continue;
		if (block.type === "text") {
			const text = asString(block.text)?.trim() ?? "";
			if (text === "") continue;
			setDoing(facts, truncate(lastLine(text), summaryLength), at);
			pushEntry(facts, { at, role: "assistant", text });
		} else if (block.type === "tool_use") {
			const name = asString(block.name) ?? "tool";
			const input = asObject(block.input) ?? {};
			const id = asString(block.id);
			if (id) facts.tools.set(id, { name, input });
			if (name === "TodoWrite") replaceTodos(facts, input.todos, at);
			const summary = summariseTool(name, input);
			setDoing(facts, summary, at);
			pushEntry(facts, { at, role: "tool", text: summary });
		}
	}
}

function countTokens(facts: TranscriptFacts, message: Json | null) {
	const usage = asObject(message?.usage);
	if (!usage) return;
	const id = asString(message?.id);
	if (id) {
		if (facts.countedMessages.has(id)) return;
		facts.countedMessages.add(id);
	}
	facts.tokens.input += tokenCount(usage.input_tokens);
	facts.tokens.output += tokenCount(usage.output_tokens);
	facts.tokens.cacheRead += tokenCount(usage.cache_read_input_tokens);
	facts.tokens.cacheWrite += tokenCount(usage.cache_creation_input_tokens);
}

function tokenCount(value: unknown): number {
	const count = asNumber(value);
	return count !== null && count > 0 ? count : 0;
}

function applyUser(
	facts: TranscriptFacts,
	record: Json,
	at: number,
	resolve: ResolvePeer,
) {
	const content = asObject(record.message)?.content;
	const origin = asObject(record.origin);
	if (Array.isArray(content) && content.some(isToolResult)) {
		applyToolResults(facts, record, content, at, resolve);
		return;
	}
	const text = contentText(content);
	if (origin?.kind === "peer") {
		applyPeer(facts, origin, text, at, resolve);
		return;
	}
	if (origin?.kind === "task-notification") {
		collectFinishedTasks(facts, text, at);
		return;
	}
	if (record.isMeta === true) return;
	if (origin && origin.kind !== "human") return;
	if (text.trim() === "") return;
	pushEntry(facts, { at, role: "user", text });
}

function applyToolResults(
	facts: TranscriptFacts,
	record: Json,
	content: unknown[],
	at: number,
	resolve: ResolvePeer,
) {
	const result = asObject(record.toolUseResult);
	collectFinishedAgent(facts, result);
	for (const item of content) {
		const block = asObject(item);
		if (block?.type !== "tool_result") continue;
		const id = asString(block.tool_use_id);
		const tool = id ? facts.tools.get(id) : undefined;
		if (id) facts.tools.delete(id);
		if (!tool || !result) continue;
		if (tool.name === "SendMessage") {
			const msgId = asString(result.msg_id);
			if (!msgId) continue;
			const address = asString(tool.input.to) ?? asString(tool.input.recipient);
			facts.sent.set(msgId, {
				at,
				summary: messageSummary(tool.input),
				to: address ? resolve(peerRefFromAddress(address)) : null,
			});
		} else if (tool.name === "TaskCreate") {
			const taskId = asString(asObject(result.task)?.id);
			const subject = asString(tool.input.subject);
			if (taskId && subject) {
				if (allCompleted(facts.tasks)) facts.tasks.clear();
				facts.tasks.set(taskId, {
					id: taskId,
					subject: truncate(subject, summaryLength),
					status: "pending",
					activeForm: activeFormOf(tool.input),
					createdAt: at,
					startedAt: null,
					endedAt: null,
				});
			}
		} else if (tool.name === "TaskUpdate") {
			if (result.success !== false) updateTask(facts, tool.input, at);
		} else if (tool.name === "TaskStop") {
			const taskId = asString(result.task_id);
			if (taskId) endTask(facts, taskId, at);
		} else if (tool.name === "Monitor") {
			startShell(facts, asString(result.taskId), tool, at);
		} else if (tool.name === "Workflow") {
			const taskId = asString(result.taskId);
			const runId = asString(result.runId);
			if (taskId && runId) facts.workflowRuns.set(taskId, runId);
			if (runId) facts.finishedTasks.delete(runId);
			const name = asString(result.workflowName);
			if (runId && name) facts.workflowNames.set(runId, name);
		} else if (tool.name === "Artifact") {
			const artifact = publishedArtifact(tool.input, result, at);
			if (artifact) {
				facts.artifacts.delete(artifact.url);
				facts.artifacts.set(artifact.url, artifact);
			}
		} else if (tool.name === "Bash") {
			startShell(facts, asString(result.backgroundTaskId), tool, at);
			const stdout = asString(result.stdout) ?? "";
			for (const match of stdout.matchAll(backgroundedPattern)) {
				if (match[1]) facts.spawnedShorts.add(match[1]);
			}
		}
	}
}

function applyPeer(
	facts: TranscriptFacts,
	origin: Json,
	text: string,
	at: number,
	resolve: ResolvePeer,
) {
	const body = asString(origin.body) ?? text;
	const name = asString(origin.name);
	const from = asString(origin.from);
	pushEntry(facts, {
		at,
		role: "peer",
		text: name ? `${name}: ${body}` : body,
	});
	const msgId = asString(origin.msg_id);
	if (msgId) {
		const pid = asNumber(origin.verifiedPeerPid);
		const candidates: PeerRef[] = [
			...(pid === null ? [] : [{ pid }]),
			...(from ? [peerRefFromAddress(from)] : []),
			...(name ? [{ name }] : []),
		];
		facts.received.set(msgId, {
			at,
			summary: truncate(firstLine(body), summaryLength),
			from: candidates.map(resolve).find((id) => id !== null) ?? null,
		});
		return;
	}
	const agentId =
		asString(origin.senderTaskId) ?? (origin.handback ? from : null);
	if (!agentId) return;
	facts.handbacks.push({
		agentId,
		at,
		summary: truncate(firstLine(body), summaryLength),
	});
	if (facts.handbacks.length > handbackLimit) facts.handbacks.shift();
}

function messageSummary(input: Json): string {
	const summary = asString(input.summary);
	if (summary) return truncate(summary, summaryLength);
	const message =
		asString(input.message) ?? asString(input.content) ?? "message";
	return truncate(firstLine(message), summaryLength);
}

function collectFinishedAgent(facts: TranscriptFacts, result: Json | null) {
	const agentId = asString(result?.agentId);
	if (agentId && result?.status === "completed") {
		facts.finishedTasks.add(agentId);
	}
}

function collectFinishedTasks(
	facts: TranscriptFacts,
	text: string,
	at: number,
) {
	for (const notification of text.split("<task-notification>").slice(1)) {
		if (isMonitorEvent(notification)) continue;
		for (const match of notification.matchAll(taskIdPattern)) {
			if (match[1]) endTask(facts, match[1], at);
		}
	}
}

function isMonitorEvent(notification: string): boolean {
	return notification.includes("<event>") && !notification.includes("<status>");
}

function startShell(
	facts: TranscriptFacts,
	taskId: string | null,
	tool: { name: string; input: Json },
	at: number,
) {
	if (!taskId || facts.shells.has(taskId)) return;
	const description =
		asString(tool.input.description) ??
		firstLine(asString(tool.input.command) ?? "");
	facts.shells.set(taskId, {
		tool: tool.name === "Monitor" ? "Monitor" : "Bash",
		description: truncate(description, summaryLength),
		startedAt: at,
		endedAt: null,
	});
}

function endTask(facts: TranscriptFacts, taskId: string, at: number) {
	facts.finishedTasks.add(taskId);
	const shell = facts.shells.get(taskId);
	if (shell && shell.endedAt === null) shell.endedAt = at;
	const runId = facts.workflowRuns.get(taskId);
	if (runId) facts.finishedTasks.add(runId);
}

function setDoing(facts: TranscriptFacts, text: string, at: number) {
	facts.doing = text;
	facts.steps.push({ at, text });
	if (facts.steps.length > stepLimit) facts.steps.shift();
}

const taskStatuses: readonly string[] = [
	"pending",
	"in_progress",
	"completed",
] satisfies TaskStatus[];

function taskStatusOf(value: unknown): TaskStatus | null {
	return typeof value === "string" && taskStatuses.includes(value)
		? (value as TaskStatus)
		: null;
}

function activeFormOf(input: Json): string | null {
	const activeForm = asString(input.activeForm)?.trim();
	return activeForm ? truncate(activeForm, summaryLength) : null;
}

function allCompleted(tasks: Map<string, Task>): boolean {
	return [...tasks.values()].every((task) => task.status === "completed");
}

function stamped(task: Task, status: TaskStatus, at: number): Task {
	return {
		...task,
		status,
		startedAt:
			status === "in_progress" ? (task.startedAt ?? at) : task.startedAt,
		endedAt: status === "completed" ? (task.endedAt ?? at) : null,
	};
}

function updateTask(facts: TranscriptFacts, input: Json, at: number) {
	const taskId = asString(input.taskId);
	const task = taskId ? facts.tasks.get(taskId) : undefined;
	if (!taskId || !task) return;
	if (input.status === "deleted") {
		facts.tasks.delete(taskId);
		return;
	}
	const subject = asString(input.subject)?.trim();
	facts.tasks.set(taskId, {
		...stamped(task, taskStatusOf(input.status) ?? task.status, at),
		subject: subject ? truncate(subject, summaryLength) : task.subject,
		activeForm: activeFormOf(input) ?? task.activeForm,
	});
}

function replaceTodos(facts: TranscriptFacts, todos: unknown, at: number) {
	if (!Array.isArray(todos)) return;
	const previous = new Map(
		[...facts.tasks.values()].map((task) => [task.subject, task]),
	);
	facts.tasks.clear();
	for (const [index, item] of todos.entries()) {
		const todo = asObject(item);
		const content = asString(todo?.content)?.trim();
		if (!todo || !content) continue;
		const id = String(index + 1);
		const subject = truncate(content, summaryLength);
		const earlier = previous.get(subject);
		const task: Task = {
			id,
			subject,
			status: "pending",
			activeForm: activeFormOf(todo),
			createdAt: earlier?.createdAt ?? at,
			startedAt: earlier?.startedAt ?? null,
			endedAt: earlier?.endedAt ?? null,
		};
		facts.tasks.set(
			id,
			stamped(task, taskStatusOf(todo.status) ?? "pending", at),
		);
	}
}

function isToolResult(item: unknown): boolean {
	return asObject(item)?.type === "tool_result";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			const block = asObject(item);
			return block?.type === "text" ? (asString(block.text) ?? "") : "";
		})
		.filter((text) => text !== "")
		.join("\n");
}

function pushEntry(facts: TranscriptFacts, entry: TranscriptEntry) {
	facts.entries.push({ ...entry, text: truncate(entry.text, entryTextLength) });
	if (facts.entries.length > entryLimit * 1.5) {
		facts.entries.splice(0, facts.entries.length - entryLimit);
	}
}
