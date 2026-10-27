import type { TranscriptEntry } from "../../shared/types.ts";
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

export type TranscriptFacts = {
	doing: string | null;
	lastAt: number;
	tools: Map<string, { name: string; input: Json }>;
	sent: Map<string, SentMessage>;
	received: Map<string, ReceivedMessage>;
	handbacks: Handback[];
	spawnedShorts: Set<string>;
	forkedChildren: Set<string>;
	finishedTasks: Set<string>;
	entries: TranscriptEntry[];
};

export const entryLimit = 2000;
const handbackLimit = 200;
const summaryLength = 80;
const entryTextLength = 4000;
const backgroundedPattern = /backgrounded · ([0-9a-f]{8})/g;
const taskIdPattern = /<task-id>([^<\s]+)<\/task-id>/g;

export function createFacts(): TranscriptFacts {
	return {
		doing: null,
		lastAt: 0,
		tools: new Map(),
		sent: new Map(),
		received: new Map(),
		handbacks: [],
		spawnedShorts: new Set(),
		forkedChildren: new Set(),
		finishedTasks: new Set(),
		entries: [],
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
			collectFinishedTasks(facts, asString(record.content) ?? "");
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

function applyAssistant(facts: TranscriptFacts, record: Json, at: number) {
	const content = asObject(record.message)?.content;
	if (!Array.isArray(content)) return;
	for (const item of content) {
		const block = asObject(item);
		if (!block) continue;
		if (block.type === "text") {
			const text = asString(block.text)?.trim() ?? "";
			if (text === "") continue;
			facts.doing = truncate(lastLine(text), summaryLength);
			pushEntry(facts, { at, role: "assistant", text });
		} else if (block.type === "tool_use") {
			const name = asString(block.name) ?? "tool";
			const input = asObject(block.input) ?? {};
			const id = asString(block.id);
			if (id) facts.tools.set(id, { name, input });
			const summary = summariseTool(name, input);
			facts.doing = summary;
			pushEntry(facts, { at, role: "tool", text: summary });
		}
	}
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
		collectFinishedTasks(facts, text);
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
		} else if (tool.name === "Bash") {
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

function collectFinishedTasks(facts: TranscriptFacts, text: string) {
	if (!text.includes("<task-notification>")) return;
	for (const match of text.matchAll(taskIdPattern)) {
		if (match[1]) facts.finishedTasks.add(match[1]);
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
