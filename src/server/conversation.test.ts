import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ConversationItem } from "../shared/conversation.ts";
import {
	advanceLog,
	applyConversationRecord,
	createLog,
	itemsBefore,
	itemsSince,
} from "./conversation.ts";

const at = "2026-10-24T10:00:00.000Z";
const later = "2026-10-24T10:00:05.000Z";

const parse = (...records: object[]) => {
	const log = createLog("/nowhere.jsonl");
	for (const record of records) {
		applyConversationRecord(log, { timestamp: at, ...record });
	}
	return log;
};

const kinds = (items: ConversationItem[]) => items.map((item) => item.kind);

const assistant = (content: object[], extra: object = {}) => ({
	type: "assistant",
	message: { id: "msg_1", model: "claude-test-1", content },
	...extra,
});

const user = (content: unknown, extra: object = {}) => ({
	type: "user",
	message: { role: "user", content },
	...extra,
});

const toolUse = (id: string, name: string, input: object) =>
	assistant([{ type: "tool_use", id, name, input }], {
		message: {
			id: `msg_${id}`,
			model: "claude-test-1",
			content: [{ type: "tool_use", id, name, input }],
		},
	});

const toolResult = (id: string, content: unknown, extra: object = {}) =>
	user([{ type: "tool_result", tool_use_id: id, content, ...extra }], {});

describe("conversation records", () => {
	it("keeps typed prompts, images and replies in order", () => {
		const log = parse(
			user("Rename the widget", {
				cwd: "/work/demo",
				gitBranch: "main",
				permissionMode: "acceptEdits",
			}),
			user([
				{ type: "text", text: "Like this one" },
				{ type: "image", source: { type: "base64", data: "" } },
			]),
			assistant([{ type: "text", text: "Done. **Renamed** it." }]),
		);
		assert.deepEqual(kinds(log.items), ["user", "user", "assistant"]);
		assert.equal(log.items[1]?.kind === "user" && log.items[1].images, 1);
		assert.equal(log.status.cwd, "/work/demo");
		assert.equal(log.status.branch, "main");
		assert.equal(log.status.permissionMode, "acceptEdits");
		assert.equal(log.status.model, "claude-test-1");
		assert.equal(log.status.turnStartedAt, Date.parse(at));
	});

	it("shows thinking only when it has text or a duration", () => {
		const log = parse(
			assistant([{ type: "thinking", thinking: "", signature: "x" }]),
			assistant([{ type: "thinking", thinking: "", signature: "x" }], {
				thinkingDurationMs: 4200,
			}),
			assistant([{ type: "thinking", thinking: "Consider the cache" }]),
			assistant([{ type: "redacted_thinking", data: "x" }], {
				thinkingDurationMs: 10,
			}),
		);
		assert.deepEqual(
			log.items.map((item) =>
				item.kind === "thinking" ? [item.text, item.durationMs] : null,
			),
			[
				["", 4200],
				["Consider the cache", null],
				["", 10],
			],
		);
	});

	it("pairs tool calls with their results, errors and images", () => {
		const log = parse(
			toolUse("t1", "Bash", { command: "ls", description: "List files" }),
			toolUse("t2", "Read", { file_path: "/work/demo/a.ts" }),
			toolUse("t3", "mcp__browser__shot", { url: "https://example.com" }),
		);
		assert.deepEqual(log.status.pendingTools, ["t1", "t2", "t3"]);
		applyConversationRecord(log, {
			...toolResult("t1", "Exit code 2\nno such file", { is_error: true }),
			toolUseResult: { stdout: "", stderr: "no such file", interrupted: false },
		});
		applyConversationRecord(
			log,
			toolResult("t3", [
				{ type: "text", text: "captured" },
				{ type: "image", source: { type: "base64", data: "" } },
			]),
		);
		const [bash, read, shot] = log.items;
		assert.equal(bash?.kind === "tool" && bash.result?.isError, true);
		assert.equal(
			bash?.kind === "tool" && bash.result?.text,
			"Exit code 2\nno such file",
		);
		assert.equal(read?.kind === "tool" && read.result, null);
		assert.equal(shot?.kind === "tool" && shot.result?.images, 1);
		assert.equal(shot?.kind === "tool" && shot.result?.text, "captured");
		assert.deepEqual(log.status.pendingTools, ["t2"]);
	});

	it("carries edit patches, subagent ids and answers from tool results", () => {
		const log = parse(
			toolUse("e1", "Edit", {
				file_path: "/work/demo/a.ts",
				old_string: "a",
				new_string: "b",
			}),
			toolUse("a1", "Agent", { description: "Survey", prompt: "Look" }),
			toolUse("q1", "AskUserQuestion", {
				questions: [{ question: "Colour?", header: "Colour", options: [] }],
			}),
		);
		applyConversationRecord(log, {
			...toolResult("e1", "Updated"),
			toolUseResult: {
				structuredPatch: [
					{
						oldStart: 3,
						oldLines: 1,
						newStart: 3,
						newLines: 1,
						lines: ["-a", "+b"],
					},
				],
			},
		});
		applyConversationRecord(
			log,
			toolResult("a1", [
				{
					type: "text",
					text: "Async agent launched successfully.\nagentId: abc123def (internal)",
				},
			]),
		);
		applyConversationRecord(log, {
			...toolResult("q1", "The user answered"),
			toolUseResult: { answers: { "Colour?": "Green", ignored: 4 } },
		});
		const [edit, agent, question] = log.items;
		assert.deepEqual(edit?.kind === "tool" && edit.result?.patch, [
			{ oldStart: 3, newStart: 3, lines: ["-a", "+b"] },
		]);
		assert.equal(agent?.kind === "tool" && agent.result?.agentId, "abc123def");
		assert.deepEqual(question?.kind === "tool" && question.result?.answers, {
			"Colour?": "Green",
		});
	});

	it("records interruptions and ends the turn", () => {
		const log = parse(
			user("Go"),
			user([
				{ type: "text", text: "[Request interrupted by user for tool use]" },
			]),
			user([{ type: "text", text: "[Request interrupted by user]" }]),
		);
		assert.deepEqual(
			log.items.map((item) =>
				item.kind === "interrupted" ? item.forTool : item.kind,
			),
			["user", true, false],
		);
		assert.equal(log.status.turnStartedAt, null);
	});

	it("folds compaction boundaries with their summaries", () => {
		const log = parse(
			{
				type: "system",
				subtype: "compact_boundary",
				content: "Conversation compacted",
				compactMetadata: { trigger: "auto", preTokens: 241000 },
			},
			user("This session is being continued…\nSummary: work so far", {
				isCompactSummary: true,
			}),
		);
		assert.deepEqual(
			log.items.map(({ index, rev, at, ...item }) => item),
			[
				{
					kind: "compaction",
					trigger: "auto",
					preTokens: 241000,
					summary: "This session is being continued…\nSummary: work so far",
				},
			],
		);
	});

	it("turns slash and shell commands into command items with output", () => {
		const log = parse(
			user(
				"<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep tests</command-args>",
			),
			user("<local-command-stdout>Compacted</local-command-stdout>"),
			{
				type: "system",
				subtype: "local_command",
				content:
					"<command-name>/model</command-name>\n<command-args></command-args>",
			},
			{
				type: "system",
				subtype: "local_command",
				content:
					"<local-command-stdout>\u001b[1mKept model\u001b[22m</local-command-stdout>",
			},
			user("<bash-input>ls</bash-input>"),
			user("<bash-stdout>a.ts\nb.ts</bash-stdout><bash-stderr></bash-stderr>"),
		);
		assert.deepEqual(
			log.items.map((item) =>
				item.kind === "command"
					? [item.name, item.args, item.output]
					: item.kind,
			),
			[
				["/compact", "keep tests", "Compacted"],
				["/model", "", "Kept model"],
				["!", "ls", "a.ts\nb.ts"],
			],
		);
	});

	it("shows notices, peers, task notifications and queued prompts", () => {
		const log = parse(
			{
				type: "system",
				subtype: "informational",
				content: "Compacted while idle",
				level: "notice",
			},
			{ type: "system", subtype: "api_error", level: "error" },
			{ type: "system", subtype: "turn_duration", durationMs: 10 },
			{ type: "system", subtype: "stop_hook_summary" },
			user("hello", {
				origin: { kind: "peer", name: "helper", body: "hello there" },
			}),
			user(
				"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>",
				{ origin: { kind: "task-notification" } },
			),
			{
				type: "attachment",
				attachment: {
					type: "queued_command",
					prompt: "also check the docs",
					origin: { kind: "human" },
				},
			},
			{
				type: "attachment",
				attachment: {
					type: "queued_command",
					prompt: "<task-notification>x</task-notification>",
				},
			},
			{
				type: "attachment",
				attachment: { type: "hook_success", content: "ok" },
			},
			user("Base directory for this skill", { isMeta: true }),
		);
		assert.deepEqual(
			log.items.map(({ index, rev, at, ...item }) => item),
			[
				{ kind: "notice", level: "info", text: "Compacted while idle" },
				{ kind: "notice", level: "error", text: "API error" },
				{ kind: "peer", from: "helper", text: "hello there" },
				{
					kind: "task",
					status: "completed",
					summary: "Background command finished",
				},
				{ kind: "user", text: "also check the docs", images: 0, queued: true },
			],
		);
	});

	it("tracks the permission mode, context and output tokens once per message", () => {
		const usage = {
			input_tokens: 10,
			cache_creation_input_tokens: 100,
			cache_read_input_tokens: 1000,
			output_tokens: 5,
		};
		const log = parse(
			{ type: "permission-mode", permissionMode: "plan" },
			{
				type: "assistant",
				message: {
					id: "m1",
					model: "claude-test-1",
					usage,
					content: [{ type: "text", text: "a" }],
				},
			},
			{
				type: "assistant",
				message: {
					id: "m1",
					model: "claude-test-1",
					usage,
					content: [{ type: "text", text: "b" }],
				},
			},
			{
				type: "assistant",
				message: {
					id: "m2",
					model: "<synthetic>",
					usage: { ...usage, output_tokens: 7 },
					content: [],
				},
			},
		);
		assert.equal(log.status.permissionMode, "plan");
		assert.equal(log.status.contextTokens, 1117);
		assert.equal(log.status.outputTokens, 12);
		assert.equal(log.status.model, "claude-test-1");
	});

	it("ignores junk, unknown records and results for unknown tools", () => {
		const log = parse(
			{ type: "mode", mode: "normal" },
			{ type: "file-history-snapshot" },
			toolResult("missing", "x"),
		);
		applyConversationRecord(log, null);
		applyConversationRecord(log, "text");
		assert.deepEqual(log.items, []);
	});
});

describe("conversation log", () => {
	const dir = mkdtempSync(join(tmpdir(), "kanban-conversation-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const line = (record: object) =>
		`${JSON.stringify({ timestamp: at, ...record })}\n`;

	it("reads appended lines, waits for partial ones and resets on truncation", () => {
		const path = join(dir, "a.jsonl");
		writeFileSync(
			path,
			line(user("one")) + line(toolUse("t1", "Bash", { command: "ls" })),
		);
		const log = createLog(path);
		assert.equal(advanceLog(log), true);
		assert.deepEqual(kinds(log.items), ["user", "tool"]);
		const seen = log.rev;
		assert.equal(advanceLog(log), false);
		const partial = line({ ...toolResult("t1", "a.ts"), timestamp: later });
		appendFileSync(path, partial.slice(0, 20));
		assert.equal(advanceLog(log), false);
		appendFileSync(path, partial.slice(20));
		assert.equal(advanceLog(log), true);
		const changed = itemsSince(log, seen);
		assert.deepEqual(
			changed.map((item) => [
				item.index,
				item.kind === "tool" && item.result?.text,
			]),
			[[1, "a.ts"]],
		);
		const epoch = log.epoch;
		writeFileSync(path, line(user("fresh")));
		advanceLog(log);
		assert.notEqual(log.epoch, epoch);
		assert.deepEqual(kinds(log.items), ["user"]);
	});

	it("pages older items before an index", () => {
		const log = parse(
			...Array.from({ length: 10 }, (_, n) => user(`prompt ${n}`)),
		);
		assert.deepEqual(
			itemsBefore(log, 6, 3).map((item) => item.index),
			[3, 4, 5],
		);
		assert.deepEqual(
			itemsBefore(log, 2, 5).map((item) => item.index),
			[0, 1],
		);
		assert.deepEqual(itemsBefore(log, 0, 5), []);
	});
});
