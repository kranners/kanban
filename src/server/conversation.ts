import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type {
	BackgroundTask,
	ConversationItem,
	ConversationStatus,
	PatchHunk,
	ToolResult,
} from "../shared/conversation.ts";
import { stripAnsi } from "./ansi.ts";
import { publishedArtifact } from "./artifacts.ts";
import {
	asNumber,
	asObject,
	asString,
	asTime,
	type Json,
	parseJson,
} from "./ingest/json.ts";

export type ConversationLog = {
	path: string;
	epoch: string;
	offset: number;
	leftover: Buffer;
	items: ConversationItem[];
	rev: number;
	tools: Map<string, number>;
	tasks: Map<string, number>;
	prompts: Map<string, number>;
	usageSeen: Set<string>;
	status: ConversationStatus;
};

type Draft = ConversationItem extends infer Item
	? Item extends ConversationItem
		? Omit<Item, "index" | "rev">
		: never
	: never;

const textLimit = 40_000;
const resultLimit = 12_000;
const inputLimit = 20_000;
const newline = 0x0a;
const interruptedPattern = /^\[Request interrupted by user( for tool use)?\]/;
const tagPattern = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);

export function createLog(path: string): ConversationLog {
	return {
		path,
		epoch: randomUUID(),
		offset: 0,
		leftover: Buffer.alloc(0),
		items: [],
		rev: 0,
		tools: new Map(),
		tasks: new Map(),
		prompts: new Map(),
		usageSeen: new Set(),
		status: {
			model: null,
			cwd: null,
			branch: null,
			permissionMode: null,
			contextTokens: null,
			outputTokens: 0,
			turnStartedAt: null,
			pendingTools: [],
		},
	};
}

export function advanceLog(log: ConversationLog): boolean {
	let size: number;
	try {
		size = statSync(log.path).size;
	} catch {
		return false;
	}
	if (size < log.offset) Object.assign(log, createLog(log.path));
	if (size === log.offset) return false;
	const chunk = Buffer.alloc(size - log.offset);
	const fd = openSync(log.path, "r");
	let read: number;
	try {
		read = readSync(fd, chunk, 0, chunk.length, log.offset);
	} finally {
		closeSync(fd);
	}
	log.offset += read;
	const data = Buffer.concat([log.leftover, chunk.subarray(0, read)]);
	const end = data.lastIndexOf(newline);
	if (end === -1) {
		log.leftover = data;
		return false;
	}
	log.leftover = Buffer.from(data.subarray(end + 1));
	const before = log.rev;
	for (const line of data.toString("utf8", 0, end).split("\n")) {
		if (line.trim() !== "") applyConversationRecord(log, parseJson(line));
	}
	return log.rev !== before;
}

export function itemsSince(
	log: ConversationLog,
	rev: number,
): ConversationItem[] {
	return log.items.filter((item) => item.rev > rev);
}

export function itemsBefore(
	log: ConversationLog,
	before: number,
	count: number,
): ConversationItem[] {
	const end = Math.max(0, Math.min(before, log.items.length));
	return log.items.slice(Math.max(0, end - count), end);
}

export function applyConversationRecord(
	log: ConversationLog,
	value: unknown,
): void {
	const record = asObject(value);
	if (!record) return;
	const at = asTime(record.timestamp) ?? 0;
	noteContext(log, record);
	switch (record.type) {
		case "assistant":
			applyAssistant(log, record, at);
			return;
		case "user":
			applyUser(log, record, at);
			return;
		case "system":
			applySystem(log, record, at);
			return;
		case "attachment":
			applyAttachment(log, record, at);
			return;
		case "permission-mode": {
			const mode = asString(record.permissionMode);
			if (mode) setStatus(log, { permissionMode: mode });
			return;
		}
	}
}

function noteContext(log: ConversationLog, record: Json) {
	const cwd = asString(record.cwd);
	const branch = asString(record.gitBranch);
	const changes: Partial<ConversationStatus> = {};
	if (cwd && cwd !== log.status.cwd) changes.cwd = cwd;
	if (branch !== null && branch !== log.status.branch) {
		changes.branch = branch === "" || branch === "HEAD" ? null : branch;
	}
	if (Object.keys(changes).length > 0) setStatus(log, changes);
}

function setStatus(log: ConversationLog, changes: Partial<ConversationStatus>) {
	log.status = { ...log.status, ...changes };
	log.rev += 1;
}

function push(log: ConversationLog, draft: Draft): ConversationItem {
	log.rev += 1;
	const item = {
		...draft,
		index: log.items.length,
		rev: log.rev,
	} as ConversationItem;
	log.items.push(item);
	return item;
}

function replace(log: ConversationLog, item: ConversationItem) {
	log.rev += 1;
	log.items[item.index] = { ...item, rev: log.rev };
}

function applyAssistant(log: ConversationLog, record: Json, at: number) {
	const message = asObject(record.message);
	if (!message) return;
	noteModel(log, message);
	noteUsage(log, message);
	const content = message.content;
	if (!Array.isArray(content)) return;
	for (const value of content) {
		const block = asObject(value);
		if (!block) continue;
		if (block.type === "text") {
			const text = asString(block.text)?.trim() ?? "";
			if (text !== "") {
				push(log, { kind: "assistant", at, text: clip(text, textLimit) });
			}
		} else if (
			block.type === "thinking" ||
			block.type === "redacted_thinking"
		) {
			const text = asString(block.thinking)?.trim() ?? "";
			const durationMs = asNumber(record.thinkingDurationMs);
			if (text === "" && durationMs === null) continue;
			push(log, {
				kind: "thinking",
				at,
				text: clip(text, textLimit),
				durationMs,
			});
		} else if (block.type === "tool_use") {
			const id = asString(block.id);
			if (!id) continue;
			const item = push(log, {
				kind: "tool",
				at,
				id,
				name: asString(block.name) ?? "tool",
				input: clipInput(asObject(block.input) ?? {}),
				result: null,
			});
			log.tools.set(id, item.index);
			setStatus(log, { pendingTools: [...log.status.pendingTools, id] });
		}
	}
}

function noteModel(log: ConversationLog, message: Json) {
	const model = asString(message.model);
	if (model && model !== "<synthetic>" && model !== log.status.model) {
		setStatus(log, { model });
	}
}

function noteUsage(log: ConversationLog, message: Json) {
	const usage = asObject(message.usage);
	const id = asString(message.id);
	if (!usage || !id || log.usageSeen.has(id)) return;
	log.usageSeen.add(id);
	const tokens = (key: string) => asNumber(usage[key]) ?? 0;
	const output = tokens("output_tokens");
	setStatus(log, {
		contextTokens:
			tokens("input_tokens") +
			tokens("cache_creation_input_tokens") +
			tokens("cache_read_input_tokens") +
			output,
		outputTokens: log.status.outputTokens + output,
	});
}

function applyUser(log: ConversationLog, record: Json, at: number) {
	const content = asObject(record.message)?.content;
	if (Array.isArray(content) && content.some(isToolResult)) {
		applyToolResults(log, record, content, at);
		return;
	}
	if (record.isCompactSummary === true) {
		applyCompactSummary(log, contentText(content), at);
		return;
	}
	const text = contentText(content);
	const origin = asObject(record.origin);
	if (origin?.kind === "peer") {
		push(log, {
			kind: "peer",
			at,
			from: asString(origin.name) ?? asString(origin.from),
			text: clip(asString(origin.body) ?? text, textLimit),
		});
		return;
	}
	if (
		origin?.kind === "task-notification" ||
		text.startsWith("<task-notification>")
	) {
		applyTaskNotification(log, text, at);
		return;
	}
	if (record.isMeta === true) return;
	const interrupted = interruptedPattern.exec(text.trim());
	if (interrupted) {
		push(log, { kind: "interrupted", at, forTool: Boolean(interrupted[1]) });
		setStatus(log, { turnStartedAt: null });
		return;
	}
	if (applyCommand(log, text, at)) return;
	const images = Array.isArray(content)
		? content.filter((item) => asObject(item)?.type === "image").length
		: 0;
	if (text.trim() === "" && images === 0) return;
	notePrompt(log, record);
	push(log, {
		kind: "user",
		at,
		text: clip(text, textLimit),
		images,
		queued: false,
	});
	const mode = asString(record.permissionMode);
	setStatus(log, {
		turnStartedAt: at,
		...(mode ? { permissionMode: mode } : {}),
	});
}

function notePrompt(log: ConversationLog, record: Json) {
	const parent = asString(record.parentUuid);
	if (!parent || record.isSidechain === true) return;
	const earlier = log.prompts.get(parent);
	if (earlier !== undefined) rewind(log, earlier);
	log.prompts.set(parent, log.items.length);
}

function rewind(log: ConversationLog, from: number) {
	for (const item of log.items.slice(from)) {
		if (item.kind !== "rewound") {
			replace(log, { kind: "rewound", index: item.index, rev: 0, at: item.at });
		}
	}
	for (const [parent, index] of log.prompts) {
		if (index >= from) log.prompts.delete(parent);
	}
	setStatus(log, {
		pendingTools: log.status.pendingTools.filter(
			(id) => (log.tools.get(id) ?? 0) < from,
		),
	});
}

function applyCommand(log: ConversationLog, text: string, at: number): boolean {
	const name = tagPattern("command-name").exec(text)?.[1];
	if (name !== undefined) {
		push(log, {
			kind: "command",
			at,
			name: name.trim(),
			args: tagPattern("command-args").exec(text)?.[1]?.trim() ?? "",
			output: "",
		});
		return true;
	}
	const bash = tagPattern("bash-input").exec(text)?.[1];
	if (bash !== undefined) {
		push(log, { kind: "command", at, name: "!", args: bash, output: "" });
		return true;
	}
	const output = [
		"local-command-stdout",
		"local-command-stderr",
		"bash-stdout",
		"bash-stderr",
	]
		.map((tag) => tagPattern(tag).exec(text)?.[1])
		.filter((part): part is string => part !== undefined);
	if (output.length === 0) return false;
	const joined = stripAnsi(output.join("\n")).trim();
	const last = log.items.at(-1);
	if (last?.kind === "command" && last.output === "") {
		replace(log, { ...last, output: clip(joined, resultLimit) });
	} else if (joined !== "") {
		push(log, {
			kind: "notice",
			at,
			level: "info",
			text: clip(joined, resultLimit),
		});
	}
	return true;
}

function applyTaskNotification(log: ConversationLog, text: string, at: number) {
	const status = tagPattern("status").exec(text)?.[1]?.trim() ?? null;
	const toolUseId = tagPattern("tool-use-id").exec(text)?.[1]?.trim();
	const taskId = tagPattern("task-id").exec(text)?.[1]?.trim();
	settleTask(
		log,
		(toolUseId ? log.tools.get(toolUseId) : undefined) ??
			(taskId ? log.tasks.get(taskId) : undefined),
		status ?? "completed",
	);
	const summary = tagPattern("summary").exec(text)?.[1]?.trim();
	if (!summary) return;
	push(log, {
		kind: "task",
		at,
		status,
		summary: clip(summary, 2000),
	});
}

function settleTask(
	log: ConversationLog,
	index: number | undefined,
	status: string,
) {
	const item = index === undefined ? undefined : log.items[index];
	if (item?.kind !== "tool" || !item.result?.task) return;
	replace(log, {
		...item,
		result: { ...item.result, task: { ...item.result.task, status } },
	});
}

function applyCompactSummary(log: ConversationLog, text: string, at: number) {
	const last = [...log.items]
		.reverse()
		.find((item) => item.kind === "compaction");
	if (last?.kind === "compaction" && last.summary === null) {
		replace(log, { ...last, summary: clip(text, textLimit) });
		return;
	}
	push(log, {
		kind: "compaction",
		at,
		trigger: null,
		preTokens: null,
		summary: clip(text, textLimit),
	});
}

function applyToolResults(
	log: ConversationLog,
	record: Json,
	content: unknown[],
	at: number,
) {
	const extra = asObject(record.toolUseResult);
	const finished: string[] = [];
	for (const value of content) {
		const block = asObject(value);
		if (block?.type !== "tool_result") continue;
		const id = asString(block.tool_use_id);
		const index = id ? log.tools.get(id) : undefined;
		const item = index === undefined ? undefined : log.items[index];
		if (!id || item?.kind !== "tool") continue;
		finished.push(id);
		const result = toolResult(item, block, extra, at);
		replace(log, { ...item, result });
		if (result.task) log.tasks.set(result.task.id, item.index);
		const stopped = item.name === "TaskStop" ? asString(extra?.task_id) : null;
		if (stopped && !result.isError) {
			settleTask(log, log.tasks.get(stopped), "stopped");
		}
	}
	if (finished.length > 0) {
		setStatus(log, {
			pendingTools: log.status.pendingTools.filter(
				(id) => !finished.includes(id),
			),
		});
	}
}

function toolResult(
	item: { name: string; input: Json },
	block: Json,
	extra: Json | null,
	at: number,
): ToolResult {
	const parts = Array.isArray(block.content)
		? block.content.map(asObject)
		: [{ type: "text", text: asString(block.content) ?? "" }];
	const text = parts
		.map((part) => (part?.type === "text" ? (asString(part.text) ?? "") : ""))
		.filter((part) => part !== "")
		.join("\n");
	return {
		text: clip(text, resultLimit),
		isError: block.is_error === true,
		images: parts.filter((part) => part?.type === "image").length,
		truncated: text.length > resultLimit,
		patch: patchOf(extra?.structuredPatch),
		agentId: asString(extra?.agentId) ?? agentIdIn(text),
		answers: answersOf(extra?.answers),
		interrupted: extra?.interrupted === true,
		artifact:
			item.name === "Artifact"
				? publishedArtifact(item.input, extra, at)
				: null,
		task: backgroundTask(extra),
		at,
	};
}

function backgroundTask(extra: Json | null): BackgroundTask | null {
	const id =
		extra?.status === "async_launched"
			? (asString(extra.taskId) ?? asString(extra.agentId))
			: asString(extra?.backgroundTaskId);
	if (!id) return null;
	return {
		id,
		runId: asString(extra?.runId),
		summary: asString(extra?.summary),
		status: null,
	};
}

function agentIdIn(text: string): string | null {
	return /agentId: ([0-9a-f]{6,})/.exec(text)?.[1] ?? null;
}

function patchOf(value: unknown): PatchHunk[] | null {
	if (!Array.isArray(value)) return null;
	const hunks = value.flatMap((entry) => {
		const hunk = asObject(entry);
		const lines = Array.isArray(hunk?.lines)
			? hunk.lines.filter((line): line is string => typeof line === "string")
			: null;
		if (!hunk || !lines) return [];
		return [
			{
				oldStart: asNumber(hunk.oldStart) ?? 0,
				newStart: asNumber(hunk.newStart) ?? 0,
				lines: lines.slice(0, 2000).map((line) => clip(line, 2000)),
			},
		];
	});
	return hunks.length > 0 ? hunks.slice(0, 200) : null;
}

function answersOf(value: unknown): Record<string, string> | null {
	const answers = asObject(value);
	if (!answers) return null;
	return Object.fromEntries(
		Object.entries(answers).flatMap(([question, answer]) =>
			typeof answer === "string" ? [[question, clip(answer, 4000)]] : [],
		),
	);
}

function applySystem(log: ConversationLog, record: Json, at: number) {
	const content = asString(record.content) ?? "";
	switch (record.subtype) {
		case "compact_boundary": {
			const meta = asObject(record.compactMetadata);
			push(log, {
				kind: "compaction",
				at,
				trigger: asString(meta?.trigger),
				preTokens: asNumber(meta?.preTokens),
				summary: null,
			});
			return;
		}
		case "turn_duration":
			setStatus(log, { turnStartedAt: null });
			return;
		case "local_command":
			applyCommand(log, content, at);
			return;
		case "informational":
		case "api_error":
		case "scheduled_task_fire": {
			const text =
				content || (record.subtype === "api_error" ? "API error" : "");
			if (text === "") return;
			push(log, {
				kind: "notice",
				at,
				level: levelOf(record.level, record.subtype),
				text: clip(text, 4000),
			});
			return;
		}
	}
}

function levelOf(
	level: unknown,
	subtype: unknown,
): "info" | "warning" | "error" {
	if (subtype === "api_error" || level === "error") return "error";
	return level === "warning" ? "warning" : "info";
}

function applyAttachment(log: ConversationLog, record: Json, at: number) {
	const attachment = asObject(record.attachment);
	if (attachment?.type !== "queued_command") return;
	if (asObject(attachment.origin)?.kind !== "human") return;
	const text = asString(attachment.prompt) ?? "";
	if (text.trim() === "") return;
	push(log, {
		kind: "user",
		at,
		text: clip(text, textLimit),
		images: 0,
		queued: true,
	});
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

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function clipInput(input: Json): Record<string, unknown> {
	return JSON.parse(
		JSON.stringify(input, (_key, value: unknown) =>
			typeof value === "string" ? clip(value, inputLimit) : value,
		),
	);
}
