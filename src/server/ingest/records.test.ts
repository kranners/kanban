import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	applyRecord,
	createFacts,
	type PeerRef,
	stepLimit,
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

	test("ends stopped tasks and the workflow runs behind ended tasks", () => {
		const facts = apply(
			toolUse("t1", "Workflow", { script: "a.js" }),
			toolResult("t1", {
				status: "async_launched",
				taskId: "w1",
				runId: "wf_a",
			}),
			toolUse("t2", "Workflow", { script: "b.js" }),
			toolResult("t2", {
				status: "async_launched",
				taskId: "w2",
				runId: "wf_b",
			}),
			toolUse("t3", "Workflow", { script: "c.js" }),
			toolResult("t3", {
				status: "async_launched",
				taskId: "w3",
				runId: "wf_c",
			}),
			toolUse("t4", "TaskStop", { task_id: "w1" }),
			toolResult("t4", { message: "Stopped", task_id: "w1" }),
			toolUse("t5", "TaskStop", { task_id: "agentE" }),
			toolResult("t5", { message: "Stopped", task_id: "agentE" }),
			{
				type: "user",
				origin: { kind: "task-notification" },
				message: {
					content:
						"<task-notification><task-id>w2</task-id><status>stopped</status></task-notification>",
				},
			},
			toolUse("t6", "TaskStop", { task_id: "w3" }),
			{
				type: "user",
				message: {
					content: [{ type: "tool_result", tool_use_id: "t6", is_error: true }],
				},
				toolUseResult: "Error: No task found with ID: w3",
			},
		);
		assert.deepEqual([...facts.finishedTasks].sort(), [
			"agentE",
			"w1",
			"w2",
			"wf_a",
			"wf_b",
		]);
	});

	test("a resumed workflow run is running again, under its name", () => {
		const facts = apply(
			toolUse("t1", "Workflow", { script: "a.js" }),
			toolResult("t1", {
				status: "async_launched",
				taskId: "w1",
				workflowName: "audit",
				runId: "wf_a",
			}),
			toolUse("t2", "TaskStop", { task_id: "w1" }),
			toolResult("t2", { message: "Stopped", task_id: "w1" }),
			toolUse("t3", "Workflow", {
				scriptPath: "a.js",
				resumeFromRunId: "wf_a",
			}),
			toolResult("t3", {
				status: "async_launched",
				taskId: "w2",
				workflowName: "audit",
				runId: "wf_a",
			}),
		);
		assert.deepEqual([...facts.finishedTasks], ["w1"]);
		assert.equal(facts.workflowNames.get("wf_a"), "audit");
	});

	test("tracks background shells and monitors until they end", () => {
		const at = (time: string) => ({ timestamp: `2026-10-24T${time}.000Z` });
		const facts = apply(
			toolUse("b1", "Bash", {
				command: "npm run dev",
				description: "Start the dev server",
				run_in_background: true,
			}),
			{ ...toolResult("b1", { backgroundTaskId: "bdev" }), ...at("10:00:01") },
			toolUse("b2", "Bash", { command: "tail -f log\nmore" }),
			{ ...toolResult("b2", { backgroundTaskId: "btail" }), ...at("10:00:02") },
			toolUse("b3", "Bash", { command: "ls" }),
			toolResult("b3", { stdout: "a" }),
			toolUse("m1", "Monitor", { description: "Watch the crawl" }),
			{ ...toolResult("m1", { taskId: "bwatch" }), ...at("10:00:03") },
			{
				type: "queue-operation",
				content:
					"<task-notification><task-id>btail</task-id><status>completed</status></task-notification>",
				...at("10:05:00"),
			},
			{
				type: "queue-operation",
				content:
					"<task-notification><task-id>bwatch</task-id><summary>Monitor event</summary><event>50/2054</event></task-notification>",
				...at("10:05:30"),
			},
			toolUse("b4", "Bash", { command: "npm test", run_in_background: true }),
			{ ...toolResult("b4", { backgroundTaskId: "btest" }), ...at("10:05:40") },
			{
				type: "attachment",
				attachment: {
					type: "queued_command",
					prompt:
						"<task-notification>\n<task-id>btest</task-id>\n<status>completed</status>\n</task-notification>",
				},
				...at("10:05:50"),
			},
			toolUse("s1", "TaskStop", { task_id: "bwatch" }),
			{ ...toolResult("s1", { task_id: "bwatch" }), ...at("10:06:00") },
		);
		const ms = (time: string) => Date.parse(`2026-10-24T${time}.000Z`);
		assert.deepEqual(Object.fromEntries(facts.shells), {
			bdev: {
				tool: "Bash",
				description: "Start the dev server",
				startedAt: ms("10:00:01"),
				endedAt: null,
			},
			btail: {
				tool: "Bash",
				description: "tail -f log",
				startedAt: ms("10:00:02"),
				endedAt: ms("10:05:00"),
			},
			bwatch: {
				tool: "Monitor",
				description: "Watch the crawl",
				startedAt: ms("10:00:03"),
				endedAt: ms("10:06:00"),
			},
			btest: {
				tool: "Bash",
				description: "npm test",
				startedAt: ms("10:05:40"),
				endedAt: ms("10:05:50"),
			},
		});
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

describe("artifacts", () => {
	const published = (id: string, input: object, result: object) => [
		toolUse(id, "Artifact", input),
		toolResult(id, result),
	];

	test("collects each published artifact once, latest publish last", () => {
		const facts = apply(
			...published(
				"p1",
				{ file_path: "/tmp/plan.html", icon: "bell" },
				{
					url: "https://claude.ai/artifact/4oVZH2uJs5GCsLdRFRZF4H",
					title: "Plan",
				},
			),
			...published(
				"p2",
				{ type_url: "https://claude.ai/artifact/GZLZthZ2sQjn7T16skfdeF" },
				{ url: "https://claude.ai/artifact/Qfn3ReKDiuFi45uako7bVQ" },
			),
			...published(
				"p3",
				{ file_path: "/tmp/plan.html" },
				{
					url: "https://claude.ai/artifact/4oVZH2uJs5GCsLdRFRZF4H",
					title: "Plan v2",
				},
			),
		);
		assert.deepEqual(
			[...facts.artifacts.values()].map(({ url, title }) => [url, title]),
			[
				["https://claude.ai/artifact/Qfn3ReKDiuFi45uako7bVQ", "Artifact"],
				["https://claude.ai/artifact/4oVZH2uJs5GCsLdRFRZF4H", "Plan v2"],
			],
		);
	});

	test("ignores opens, asset uploads and links off claude.ai", () => {
		const shortlist = "https://claude.ai/artifact/5qfwzY679vZHW1W3ZGiChd";
		const facts = apply(
			...published(
				"o1",
				{ action: "open", url: shortlist },
				{ url: shortlist, title: "Shortlist" },
			),
			...published("a1", { asset: true, url: shortlist }, { url: shortlist }),
			...published(
				"x1",
				{ file_path: "/tmp/x.html" },
				{ url: "javascript:alert(1)//claude.ai/artifact/x", title: "Bad" },
			),
			...published(
				"x2",
				{ file_path: "/tmp/x.html" },
				{ url: "https://claude.ai.example.com/artifact/abc", title: "Bad" },
			),
		);
		assert.equal(facts.artifacts.size, 0);
	});
});

describe("tasks", () => {
	test("tracks the task list through TaskCreate and TaskUpdate", () => {
		const facts = apply(
			toolUse("c1", "TaskCreate", {
				subject: "Write the parser",
				description: "x",
				activeForm: "Writing the parser",
			}),
			toolResult("c1", { task: { id: "1", subject: "Write the parser" } }),
			toolUse("c2", "TaskCreate", { subject: "Ship it", description: "y" }),
			toolResult("c2", { task: { id: "2", subject: "Ship it" } }),
			toolUse("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
			toolResult("u1", { success: true, taskId: "1" }),
			toolUse("u2", "TaskUpdate", { taskId: "2", status: "in_progress" }),
			toolResult("u2", { success: true, taskId: "2" }),
		);
		assert.deepEqual(
			[...facts.tasks.values()],
			[
				{
					id: "1",
					subject: "Write the parser",
					status: "completed",
					activeForm: "Writing the parser",
					createdAt: Date.parse("2026-10-24T10:00:00.000Z"),
					startedAt: null,
					endedAt: Date.parse("2026-10-24T10:00:00.000Z"),
				},
				{
					id: "2",
					subject: "Ship it",
					status: "in_progress",
					activeForm: null,
					createdAt: Date.parse("2026-10-24T10:00:00.000Z"),
					startedAt: Date.parse("2026-10-24T10:00:00.000Z"),
					endedAt: null,
				},
			],
		);
	});

	test("times when each task was created, started and finished", () => {
		const at = (time: string) => ({
			timestamp: `2026-10-24T${time}.000Z`,
		});
		const facts = apply(
			{
				...toolUse("c1", "TaskCreate", { subject: "Parse" }),
				...at("10:00:00"),
			},
			{ ...toolResult("c1", { task: { id: "1" } }), ...at("10:00:01") },
			{
				...toolUse("u1", "TaskUpdate", { taskId: "1", status: "in_progress" }),
				...at("10:02:00"),
			},
			{ ...toolResult("u1", { success: true }), ...at("10:02:01") },
			{
				...toolUse("u2", "TaskUpdate", { taskId: "1", status: "in_progress" }),
				...at("10:05:00"),
			},
			{ ...toolResult("u2", { success: true }), ...at("10:05:01") },
			{
				...toolUse("u3", "TaskUpdate", { taskId: "1", status: "completed" }),
				...at("10:09:00"),
			},
			{ ...toolResult("u3", { success: true }), ...at("10:09:01") },
		);
		const task = facts.tasks.get("1");
		assert.deepEqual(
			[task?.createdAt, task?.startedAt, task?.endedAt],
			[
				Date.parse("2026-10-24T10:00:01.000Z"),
				Date.parse("2026-10-24T10:02:01.000Z"),
				Date.parse("2026-10-24T10:09:01.000Z"),
			],
		);
	});

	test("drops deleted tasks and ignores failed updates", () => {
		const facts = apply(
			toolUse("c1", "TaskCreate", { subject: "Keep" }),
			toolResult("c1", { task: { id: "1" } }),
			toolUse("c2", "TaskCreate", { subject: "Drop" }),
			toolResult("c2", { task: { id: "2" } }),
			toolUse("u1", "TaskUpdate", { taskId: "2", status: "deleted" }),
			toolResult("u1", { success: true }),
			toolUse("u2", "TaskUpdate", { taskId: "1", status: "completed" }),
			toolResult("u2", { success: false }),
		);
		assert.deepEqual(
			[...facts.tasks.values()].map((task) => [task.subject, task.status]),
			[["Keep", "pending"]],
		);
	});

	test("starts a fresh list once every earlier task is completed", () => {
		const facts = apply(
			toolUse("c1", "TaskCreate", { subject: "Old plan" }),
			toolResult("c1", { task: { id: "1" } }),
			toolUse("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
			toolResult("u1", { success: true }),
			toolUse("c2", "TaskCreate", { subject: "New plan" }),
			toolResult("c2", { task: { id: "2" } }),
			toolUse("c3", "TaskCreate", { subject: "Next step" }),
			toolResult("c3", { task: { id: "3" } }),
		);
		assert.deepEqual(
			[...facts.tasks.values()].map((task) => task.subject),
			["New plan", "Next step"],
		);
	});

	test("replaces the list on every TodoWrite", () => {
		const facts = apply(
			toolUse("t1", "TodoWrite", {
				todos: [{ content: "Old", status: "pending", activeForm: "Olding" }],
			}),
			toolUse("t2", "TodoWrite", {
				todos: [
					{ content: "Read", status: "completed", activeForm: "Reading" },
					{ content: "Write", status: "in_progress", activeForm: "Writing" },
				],
			}),
		);
		assert.deepEqual(
			[...facts.tasks.values()].map((task) => [
				task.subject,
				task.status,
				task.activeForm,
			]),
			[
				["Read", "completed", "Reading"],
				["Write", "in_progress", "Writing"],
			],
		);
	});

	test("carries a todo's times across rewrites of the list", () => {
		const at = (time: string) => ({
			timestamp: `2026-10-24T${time}.000Z`,
		});
		const facts = apply(
			{
				...toolUse("t1", "TodoWrite", {
					todos: [
						{ content: "Read", status: "in_progress" },
						{ content: "Write", status: "pending" },
					],
				}),
				...at("10:00:00"),
			},
			{
				...toolUse("t2", "TodoWrite", {
					todos: [
						{ content: "Read", status: "completed" },
						{ content: "Write", status: "in_progress" },
					],
				}),
				...at("10:07:00"),
			},
		);
		const time = (clock: string) => Date.parse(`2026-10-24T${clock}.000Z`);
		assert.deepEqual(
			[...facts.tasks.values()].map((task) => [
				task.createdAt,
				task.startedAt,
				task.endedAt,
			]),
			[
				[time("10:00:00"), time("10:00:00"), time("10:07:00")],
				[time("10:00:00"), time("10:07:00"), null],
			],
		);
	});
});

describe("steps", () => {
	test("keeps the latest steps with their times", () => {
		const facts = createFacts();
		for (let i = 0; i < stepLimit + 2; i++) {
			applyRecord(
				facts,
				{
					sessionId,
					timestamp: new Date(Date.UTC(2026, 9, 24, 10, i)).toISOString(),
					...toolUse(`b${i}`, "Bash", { description: `step ${i}` }),
				},
				resolve,
			);
		}
		assert.equal(facts.steps.length, stepLimit);
		assert.equal(facts.steps[0]?.text, "Bash: step 2");
		assert.equal(facts.steps.at(-1)?.text, `Bash: step ${stepLimit + 1}`);
		assert.equal(
			facts.steps.at(-1)?.at,
			Date.UTC(2026, 9, 24, 10, stepLimit + 1),
		);
	});
});
