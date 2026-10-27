import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	applyRecord,
	createFacts,
	type PeerRef,
	summariseTool,
} from "./records.ts";

const sessionId = "11111111-0000-0000-0000-000000000000";
const peers: Record<string, string> = {
	"pid:4242": "peer-session",
	"socket:/tmp/cc-socks/4242.sock": "peer-session",
	"name:acme-api": "acme-session",
};
const resolve = (ref: PeerRef) =>
	(ref.pid !== undefined ? peers[`pid:${ref.pid}`] : undefined) ??
	(ref.socket !== undefined ? peers[`socket:${ref.socket}`] : undefined) ??
	(ref.name !== undefined ? peers[`name:${ref.name}`] : undefined) ??
	null;

function apply(...records: object[]) {
	const facts = createFacts();
	for (const record of records) {
		applyRecord(
			facts,
			{ sessionId, timestamp: "2026-10-24T10:00:00.000Z", ...record },
			resolve,
		);
	}
	return facts;
}

const toolUse = (id: string, name: string, input: object) => ({
	type: "assistant",
	message: { content: [{ type: "tool_use", id, name, input }] },
});

const toolResult = (id: string, toolUseResult: object) => ({
	type: "user",
	message: { content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
	toolUseResult,
});

describe("summariseTool", () => {
	test("prefers description, then file path, then first command line", () => {
		assert.equal(
			summariseTool("Bash", { description: "Run tests", command: "npm t" }),
			"Bash: Run tests",
		);
		assert.equal(
			summariseTool("Read", { file_path: "/Users/me/dev/acme-api/a.ts" }),
			"Read: /Users/me/dev/acme-api/a.ts",
		);
		assert.equal(
			summariseTool("Bash", { command: "\n  git status\ngit diff" }),
			"Bash: git status",
		);
		assert.equal(summariseTool("TodoWrite", {}), "TodoWrite");
	});

	test("truncates to 80 characters", () => {
		const summary = summariseTool("Bash", { description: "x".repeat(200) });
		assert.equal(summary.length, 80);
		assert.ok(summary.endsWith("…"));
	});
});

describe("applyRecord", () => {
	test("doing follows the latest tool use or assistant text line", () => {
		const facts = apply(toolUse("t1", "Edit", { file_path: "/a.ts" }), {
			type: "assistant",
			message: { content: [{ type: "text", text: "First\n\nAll done.\n" }] },
		});
		assert.equal(facts.doing, "All done.");
		const later = apply(
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Looking" }] },
			},
			toolUse("t2", "Grep", { pattern: "TODO" }),
		);
		assert.equal(later.doing, "Grep: TODO");
	});

	test("records SendMessage results with msg_id and resolves the recipient", () => {
		const facts = apply(
			toolUse("t1", "SendMessage", {
				to: "acme-api",
				summary: "please rebase",
				message: "body",
			}),
			toolResult("t1", { success: true, msg_id: "m-1" }),
			toolUse("t2", "SendMessage", { to: "uds:/tmp/cc-socks/4242.sock" }),
			toolResult("t2", { success: true, msg_id: "m-2" }),
			toolUse("t3", "SendMessage", { to: "a1b2c3", message: "resume" }),
			toolResult("t3", { success: true, resumedAgentId: "a1b2c3" }),
		);
		assert.deepEqual([...facts.sent.keys()], ["m-1", "m-2"]);
		assert.equal(facts.sent.get("m-1")?.to, "acme-session");
		assert.equal(facts.sent.get("m-1")?.summary, "please rebase");
		assert.equal(facts.sent.get("m-2")?.to, "peer-session");
		assert.equal(facts.tools.size, 0);
	});

	test("records peer messages by msg_id with the sender resolved by pid", () => {
		const facts = apply({
			type: "user",
			isMeta: true,
			message: { content: "Another Claude session sent a message: …" },
			origin: {
				kind: "peer",
				from: "uds:/tmp/cc-socks/9999.sock",
				verifiedPeerPid: 4242,
				msg_id: "m-9",
				name: "builder",
				body: "status?\nmore",
			},
		});
		assert.deepEqual(facts.received.get("m-9"), {
			at: Date.parse("2026-10-24T10:00:00.000Z"),
			summary: "status?",
			from: "peer-session",
		});
		assert.deepEqual(
			facts.entries.map((entry) => [entry.role, entry.text]),
			[["peer", "builder: status?\nmore"]],
		);
	});

	test("records subagent handbacks", () => {
		const facts = apply({
			type: "user",
			isMeta: true,
			message: { content: "…" },
			origin: {
				kind: "peer",
				from: "agent42",
				senderTaskId: "agent42",
				handback: true,
				name: "Explore",
				body: "Found it",
			},
		});
		assert.deepEqual(
			facts.handbacks.map((handback) => [handback.agentId, handback.summary]),
			[["agent42", "Found it"]],
		);
	});

	test("finds backgrounded shorts only in Bash results", () => {
		const facts = apply(
			toolUse("t1", "Bash", { command: "claude --bg 'hi'" }),
			toolResult("t1", {
				stdout: "backgrounded · 0a1b2c3d · acme-api fix\n",
				stderr: "",
			}),
			toolUse("t2", "Read", { file_path: "/notes.md" }),
			toolResult("t2", { stdout: "backgrounded · ffffffff", type: "text" }),
		);
		assert.deepEqual([...facts.spawnedShorts], ["0a1b2c3d"]);
	});

	test("records continued-in forks and finished task notifications", () => {
		const facts = apply(
			{ type: "continued-in", continuedInSessionId: "child-session" },
			{
				type: "queue-operation",
				operation: "enqueue",
				content:
					"<task-notification>\n<task-id>agentA</task-id>\n<status>completed</status>",
			},
			{
				type: "user",
				origin: { kind: "task-notification" },
				message: {
					content:
						"<task-notification><task-id>agentB</task-id></task-notification>",
				},
			},
			{ type: "queue-operation", content: "<task-id>notone</task-id>" },
		);
		assert.deepEqual([...facts.forkedChildren], ["child-session"]);
		assert.deepEqual([...facts.finishedTasks].sort(), ["agentA", "agentB"]);
	});

	test("records agents that finished in the foreground", () => {
		const facts = apply(
			toolUse("t1", "Agent", { description: "Survey", prompt: "go" }),
			toolResult("t1", { status: "completed", agentId: "agentC" }),
			toolUse("t2", "Agent", { description: "Later", prompt: "go" }),
			toolResult("t2", { status: "async_launched", agentId: "agentD" }),
		);
		assert.deepEqual([...facts.finishedTasks], ["agentC"]);
	});

	test("keeps typed user text and skips meta, tool results and notifications", () => {
		const facts = apply(
			{ type: "user", message: { content: "fix the build" } },
			{
				type: "user",
				origin: { kind: "human" },
				message: { content: [{ type: "text", text: "and test it" }] },
			},
			{ type: "user", isMeta: true, message: { content: "caveat" } },
			toolResult("missing", { stdout: "x" }),
			{
				type: "user",
				origin: { kind: "task-notification" },
				message: { content: "<task-notification/>" },
			},
		);
		assert.deepEqual(
			facts.entries.map((entry) => [entry.role, entry.text]),
			[
				["user", "fix the build"],
				["user", "and test it"],
			],
		);
	});

	test("ignores history inherited from a fork parent", () => {
		const facts = apply(
			{
				...toolUse("t1", "Bash", { command: "x" }),
				session_id: "parent-session",
			},
			{ type: "continued-in", continuedInSessionId: "c", session_id: "p" },
		);
		assert.equal(facts.doing, null);
		assert.equal(facts.forkedChildren.size, 0);
	});

	test("keeps the latest ai title and last prompt, skipping empty ones", () => {
		const facts = apply(
			{ type: "ai-title", aiTitle: "First title" },
			{ type: "last-prompt", lastPrompt: "fix the build" },
			{ type: "ai-title", aiTitle: "  Latest title  " },
			{ type: "ai-title", aiTitle: "" },
			{ type: "last-prompt", leafUuid: "u1" },
		);
		assert.equal(facts.aiTitle, "Latest title");
		assert.equal(facts.lastPrompt, "fix the build");
	});

	test("keeps the last human prompt over relayed and shell prompts", () => {
		const facts = apply(
			{
				type: "last-prompt",
				lastPrompt: "[Image #1] [Image #2] fix the build",
			},
			{ type: "last-prompt", lastPrompt: "! git status" },
			{
				type: "last-prompt",
				lastPrompt: "Another Claude session sent a message: <teammate-message>",
			},
			{
				type: "last-prompt",
				lastPrompt: "[Artifact comment sent to Claude] hi",
			},
			{
				type: "last-prompt",
				lastPrompt: "<command-name>/clear</command-name>",
			},
		);
		assert.equal(facts.lastPrompt, "fix the build");
	});

	test("ignores titles and prompts inherited from a fork parent", () => {
		const facts = apply(
			{ type: "ai-title", aiTitle: "Parent title", session_id: "p" },
			{ type: "last-prompt", lastPrompt: "parent prompt", session_id: "p" },
		);
		assert.equal(facts.aiTitle, null);
		assert.equal(facts.lastPrompt, null);
	});
});
