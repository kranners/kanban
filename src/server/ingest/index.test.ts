import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Board } from "../../shared/types.ts";
import { goalOf, startBoard } from "./index.ts";
import { createFacts } from "./records.ts";
import type { Job } from "./registry.ts";
import { subagentLimit } from "./subagents.ts";

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const lead = "aaaaaaaa-0000-4000-8000-000000000001";
const worker = "0a1b2c3d-0000-4000-8000-000000000002";
const fork = "0f0f0f0f-0000-4000-8000-000000000003";
const dead = "dddddddd-0000-4000-8000-000000000004";
const old = "0e0e0e0e-0000-4000-8000-000000000005";
const probe = "0c0c0c0c-0000-4000-8000-000000000006";
const deadPid = 2 ** 22 - 7;
const leadDir = "-Users-me-dev-acme-api";

let home: string;

function write(path: string, value: unknown) {
	const full = join(home, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(
		full,
		typeof value === "string" ? value : JSON.stringify(value, null, 2),
	);
}

function jsonl(path: string, records: object[]) {
	write(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

function touch(path: string, ageMs: number) {
	const time = new Date(now - ageMs);
	utimesSync(join(home, path), time, time);
}

const assistant = (offset: number, content: object[], extra = {}) => ({
	type: "assistant",
	sessionId: lead,
	session_id: lead,
	timestamp: iso(offset),
	message: { role: "assistant", content },
	...extra,
});

const result = (offset: number, id: string, toolUseResult: object) => ({
	type: "user",
	sessionId: lead,
	timestamp: iso(offset),
	message: {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
	},
	toolUseResult,
});

const backgroundShell = (
	offset: number,
	id: string,
	taskId: string,
	description: string,
) => [
	assistant(offset, [
		{
			type: "tool_use",
			id,
			name: "Bash",
			input: { command: "npm start", description, run_in_background: true },
		},
	]),
	result(offset + 1, id, { stdout: "", backgroundTaskId: taskId }),
];

function buildFixture() {
	write(`sessions/${process.pid}.json`, {
		pid: process.pid,
		sessionId: lead,
		cwd: "/Users/me/dev/acme-api",
		startedAt: now - 3_600_000,
		kind: "interactive",
		entrypoint: "cli",
		messagingSocketPath: "/tmp/cc-socks/lead.sock",
		name: "acme-lead",
		status: "busy",
		statusUpdatedAt: now - 60_000,
		updatedAt: now - 60_000,
	});
	write(`sessions/${process.pid}.deadbeef.key`, "not json and never read");
	write(`sessions/${process.ppid}.json`, {
		pid: process.ppid,
		sessionId: worker,
		jobId: "0a1b2c3d",
		cwd: "/Users/me/dev/acme-web",
		startedAt: now - 1_800_000,
		kind: "bg",
		messagingSocketPath: "/tmp/cc-socks/worker.sock",
		name: "acme-web fix",
		status: "idle",
		updatedAt: now - 120_000,
	});
	write("sessions/1.json", {
		pid: 1,
		sessionId: probe,
		cwd: "/Users/me/dev/acme-api",
		startedAt: now - 1000,
		kind: "interactive",
		entrypoint: "sdk-cli",
		status: "busy",
		updatedAt: now - 1000,
	});
	write(`sessions/${deadPid}.json`, {
		pid: deadPid,
		sessionId: dead,
		cwd: "/Users/me/dev/acme-gone",
		startedAt: now - 7_200_000,
		kind: "interactive",
		name: "gone",
		status: "idle",
		updatedAt: now - 7_200_000,
	});
	write("jobs/0a1b2c3d/state.json", {
		state: "blocked",
		detail: "waiting for deploy approval",
		needs: "Approve deploy?",
		tempo: "blocked",
		name: "acme-web fix",
		sessionId: worker,
		cwd: "/Users/me/dev/acme-web",
		createdAt: iso(-1_800_000),
		updatedAt: iso(-90_000),
	});
	write("jobs/0f0f0f0f/state.json", {
		state: "blocked",
		detail: "forked to finish docs",
		needs: "stale question",
		name: "acme-api docs",
		sessionId: fork,
		cwd: "/Users/me/dev/acme-api",
		createdAt: iso(-3_000_000),
		updatedAt: iso(-3_000_000),
	});
	write("jobs/0e0e0e0e/state.json", {
		state: "done",
		name: "ancient",
		sessionId: old,
		cwd: "/Users/me/dev/acme-old",
		createdAt: iso(-200_000_000),
		updatedAt: iso(-172_800_000),
	});
	write("jobs/pins.json", "{}");
	write("jobs/.draft-12345678", "draft");

	jsonl(`projects/${leadDir}/${lead}.jsonl`, [
		{
			type: "user",
			sessionId: lead,
			timestamp: iso(-600_000),
			origin: { kind: "human" },
			message: { role: "user", content: "ship the acme fix" },
		},
		assistant(-590_000, [
			{
				type: "tool_use",
				id: "t-agent",
				name: "Agent",
				input: { description: "Explore repo", prompt: "look" },
			},
		]),
		assistant(-580_000, [
			{
				type: "tool_use",
				id: "t-bash",
				name: "Bash",
				input: { command: "claude --bg 'fix web'", description: "Start" },
			},
		]),
		result(-579_000, "t-bash", {
			stdout: "backgrounded · 0a1b2c3d · acme-web fix\n",
			stderr: "",
		}),
		assistant(-570_000, [
			{
				type: "tool_use",
				id: "t-send",
				name: "SendMessage",
				input: {
					to: "acme-web fix",
					summary: "rebase on main",
					message: "please rebase",
				},
			},
		]),
		result(-569_000, "t-send", {
			success: true,
			message: "“rebase on main” → acme-web fix",
			msg_id: "msg-1",
		}),
		{
			type: "continued-in",
			timestamp: iso(-560_000),
			sessionId: lead,
			continuedInSessionId: fork,
		},
		{
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(-550_000),
			sessionId: lead,
			content:
				"<task-notification>\n<task-id>agentdone</task-id>\n<status>completed</status>\n</task-notification>",
		},
		assistant(-548_000, [
			{
				type: "tool_use",
				id: "t-flow",
				name: "Workflow",
				input: { script: "audit.js" },
			},
		]),
		result(-547_000, "t-flow", {
			status: "async_launched",
			taskId: "wflowtask",
			workflowName: "audit",
			runId: "wf_2",
		}),
		assistant(-547_500, [
			{
				type: "tool_use",
				id: "t-review",
				name: "Workflow",
				input: { script: "review.js" },
			},
		]),
		result(-547_400, "t-review", {
			status: "async_launched",
			taskId: "wreviewtask",
			workflowName: "review-changes",
			runId: "wf_1",
		}),
		assistant(-546_000, [
			{
				type: "tool_use",
				id: "t-stop",
				name: "TaskStop",
				input: { task_id: "wflowtask" },
			},
		]),
		result(-545_000, "t-stop", {
			message: "Successfully stopped task: wflowtask",
			task_id: "wflowtask",
		}),
		...backgroundShell(-544_000, "t-serve", "bserve", "Serve the api"),
		...backgroundShell(-543_000, "t-build", "bbuild", "Build once"),
		{
			type: "queue-operation",
			operation: "enqueue",
			timestamp: iso(-542_000),
			sessionId: lead,
			content:
				"<task-notification>\n<task-id>bbuild</task-id>\n<status>completed</status>\n</task-notification>",
		},
		assistant(-540_000, [{ type: "text", text: "Now editing.\n" }]),
		assistant(-530_000, [
			{
				type: "tool_use",
				id: "t-edit",
				name: "Edit",
				input: { file_path: "/Users/me/dev/acme-api/src/a.ts" },
			},
		]),
	]);
	const subagents = `projects/${leadDir}/${lead}/subagents`;
	const agent = (
		path: string,
		meta: object,
		ageMs: number,
		records: object[] = [],
	) => {
		write(`${subagents}/${path}.meta.json`, meta);
		jsonl(`${subagents}/${path}.jsonl`, records);
		touch(`${subagents}/${path}.jsonl`, ageMs);
	};
	agent(
		"agent-agentlive",
		{ agentType: "Explore", description: "Explore repo", toolUseId: "t-agent" },
		5_000,
		[
			{
				...assistant(-450_000, [
					{
						type: "tool_use",
						id: "s-bash",
						name: "Bash",
						input: { command: "claude --bg docs" },
					},
				]),
				isSidechain: true,
				agentId: "agentlive",
			},
			result(-449_000, "s-bash", { stdout: "backgrounded · 0f0f0f0f · docs" }),
			assistant(-440_000, [
				{
					type: "tool_use",
					id: "s-send",
					name: "SendMessage",
					input: {
						to: "uds:/tmp/cc-socks/worker.sock",
						message: "hello\nthere",
					},
				},
			]),
			result(-439_000, "s-send", { success: true, msg_id: "msg-3" }),
			...backgroundShell(-438_000, "s-watch", "bwatch", "Watch the tests"),
		],
	);
	agent(
		"workflows/wf_1/agent-agentnested",
		{
			agentType: "fork",
			description: "Nested",
			parentAgentId: "agentlive",
		},
		10_000,
	);
	agent(
		"agent-agentdone",
		{ agentType: "general-purpose", description: "Done one" },
		20_000,
		backgroundShell(-430_000, "d-tail", "btail", "Tail the log"),
	);
	agent(
		"workflows/wf_1/agent-agentflowdone",
		{ agentType: "workflow-subagent", description: "Flow step" },
		5_000,
	);
	jsonl(`${subagents}/workflows/wf_1/journal.jsonl`, [
		{ type: "started", agentId: "agentnested" },
		{ type: "started", agentId: "agentflowdone" },
		{ type: "result", agentId: "agentflowdone", result: "ok" },
	]);
	agent(
		"agent-agentidle",
		{ agentType: "general-purpose", description: "Quiet one" },
		600_000,
		[
			result(-610_000, "i-agent", {
				agentId: "agentinner",
				status: "completed",
			}),
		],
	);
	agent(
		"agent-agentinner",
		{
			agentType: "general-purpose",
			description: "Inner",
			parentAgentId: "agentidle",
		},
		620_000,
	);
	agent(
		"agent-agentblocked",
		{ agentType: "general-purpose", description: "Long build" },
		300_000,
		[
			assistant(-300_000, [
				{
					type: "tool_use",
					id: "b-bash",
					name: "Bash",
					input: { command: "npm run build" },
				},
			]),
		],
	);
	agent(
		"workflows/wf_2/agent-agentflowstopped",
		{ agentType: "workflow-subagent", description: "Stopped step" },
		300_000,
	);
	jsonl(`${subagents}/workflows/wf_2/journal.jsonl`, [
		{ type: "started", agentId: "agentflowstopped" },
	]);
	write(`projects/${leadDir}/${fork}/subagents/agent-agentorphan.meta.json`, {
		agentType: "general-purpose",
		description: "Orphaned",
	});
	jsonl(`projects/${leadDir}/${fork}/subagents/agent-agentorphan.jsonl`, []);
	touch(`projects/${leadDir}/${fork}/subagents/agent-agentorphan.jsonl`, 5_000);
	agent(
		"agent-agentold",
		{ agentType: "general-purpose", description: "Old one" },
		2 * 3_600_000,
	);

	jsonl(`projects/-Users-me-dev-acme-web-worktree/${worker}.jsonl`, [
		{
			type: "user",
			sessionId: worker,
			isMeta: true,
			timestamp: iso(-568_000),
			origin: {
				kind: "peer",
				from: "uds:/tmp/cc-socks/lead.sock",
				verifiedPeerPid: process.pid,
				msg_id: "msg-1",
				name: "acme-lead",
				body: "please rebase",
			},
			message: { role: "user", content: "Another Claude session sent…" },
		},
		{
			type: "user",
			sessionId: worker,
			isMeta: true,
			timestamp: iso(-500_000),
			origin: {
				kind: "peer",
				from: "uds:/tmp/cc-socks/lead.sock",
				verifiedPeerPid: process.pid,
				msg_id: "msg-2",
				name: "acme-lead",
				body: "status?",
			},
			message: { role: "user", content: "Another Claude session sent…" },
		},
		{
			type: "user",
			sessionId: worker,
			isMeta: true,
			timestamp: iso(-400_000),
			origin: {
				kind: "peer",
				from: "uds:/tmp/cc-socks/nobody.sock",
				verifiedPeerPid: deadPid,
				msg_id: "msg-unknown",
				name: "stranger",
				body: "hi",
			},
			message: { role: "user", content: "…" },
		},
		{
			type: "user",
			sessionId: worker,
			isMeta: true,
			timestamp: iso(-300_000),
			origin: {
				kind: "peer",
				from: "agentworker",
				senderTaskId: "agentworker",
				handback: true,
				name: "Explore",
				body: "Found the bug",
			},
			message: { role: "user", content: "…" },
		},
		{
			type: "user",
			sessionId: worker,
			isMeta: true,
			timestamp: iso(-200_000),
			origin: {
				kind: "peer",
				from: "agentlive",
				senderTaskId: "agentlive",
				handback: true,
				name: "Explore",
				body: "Listed the files",
			},
			message: { role: "user", content: "…" },
		},
	]);
	jsonl(`projects/${leadDir}/${fork}.jsonl`, [
		{ type: "ai-title", sessionId: fork, aiTitle: "Docs" },
	]);
}

describe("startBoard", () => {
	let board: Board;
	let handle: ReturnType<typeof startBoard>;
	const changes: Board[] = [];

	before(() => {
		home = mkdtempSync(join(tmpdir(), "kanban-ingest-"));
		buildFixture();
		handle = startBoard({
			claudeHome: home,
			onChange: (next) => changes.push(next),
			ignore: (id) => id === probe,
			inCmux: (pid) => pid === process.pid,
		});
		board = handle.board();
	});

	after(() => {
		handle.stop();
		rmSync(home, { recursive: true, force: true });
	});

	const session = (id: string) => {
		const found = board.sessions.find((item) => item.id === id);
		assert.ok(found, `session ${id} on the board`);
		return found;
	};

	test("lists live sessions and recent jobs, dropping dead, old and ignored ones", () => {
		assert.deepEqual(
			board.sessions.map((item) => item.id).sort(),
			[worker, fork, lead].sort(),
		);
	});

	test("derives an interactive session from the registry and transcript", () => {
		assert.deepEqual(session(lead), {
			id: lead,
			short: null,
			pid: process.pid,
			name: "acme-lead",
			cwd: "/Users/me/dev/acme-api",
			project: "acme-api",
			kind: "interactive",
			activity: "working",
			doing: "Edit: /Users/me/dev/acme-api/src/a.ts",
			needs: null,
			goal: null,
			startedAt: now - 3_600_000,
			updatedAt: now - 60_000,
			attachable: false,
			cmux: true,
			artifacts: [],
		});
	});

	test("merges job state into a live background session", () => {
		const item = session(worker);
		assert.equal(item.kind, "background");
		assert.equal(item.short, "0a1b2c3d");
		assert.equal(item.activity, "needs-you");
		assert.equal(item.needs, "Approve deploy?");
		assert.equal(item.doing, "waiting for deploy approval");
		assert.equal(item.attachable, true);
		assert.equal(item.project, "acme-web");
	});

	test("shows a job whose process is gone as stopped and attachable", () => {
		const item = session(fork);
		assert.equal(item.pid, null);
		assert.equal(item.activity, "stopped");
		assert.equal(item.needs, null);
		assert.equal(item.name, "acme-api docs");
		assert.equal(item.goal, "Docs");
		assert.equal(item.attachable, true);
	});

	test("lists recent subagents as working, idle or done, counting them per session", () => {
		const states = Object.fromEntries(
			board.subagents
				.filter((item) => item.kind === "agent")
				.map((item) => [item.id, [item.live, item.done]]),
		);
		assert.deepEqual(states, {
			agentlive: [true, false],
			agentnested: [true, false],
			agentdone: [false, true],
			agentflowdone: [false, true],
			agentidle: [false, false],
			agentinner: [false, true],
			agentblocked: [true, false],
			agentflowstopped: [false, true],
			agentorphan: [false, true],
		});
		assert.deepEqual(board.subagentCounts, {
			[lead]: { working: 3, idle: 1, done: 4 },
			[fork]: { working: 0, idle: 0, done: 1 },
		});
		assert.deepEqual(board.workflows, [
			{
				runId: "wf_1",
				sessionId: lead,
				name: "review-changes",
				done: 1,
				total: 2,
			},
		]);
		const nested = board.subagents.find((item) => item.id === "agentnested");
		assert.equal(nested?.parentAgentId, "agentlive");
		assert.equal(nested?.sessionId, lead);
		assert.equal(nested?.type, "fork");
	});

	test("shows background shells as nodes that run until they end, outside the subagent counts", () => {
		const shells = board.subagents.filter((item) => item.kind === "shell");
		assert.deepEqual(
			Object.fromEntries(
				shells.map((item) => [
					item.id,
					[item.description, item.parentAgentId, item.live, item.done],
				]),
			),
			{
				bserve: ["Serve the api", null, true, false],
				bbuild: ["Build once", null, false, true],
				bwatch: ["Watch the tests", "agentlive", true, false],
				btail: ["Tail the log", "agentdone", false, true],
			},
		);
		assert.deepEqual(Object.keys(board.subagentStates).sort(), [
			"agentblocked",
			"agentidle",
			"agentlive",
			"agentnested",
		]);
	});

	test("links spawned, forked and subagent nodes", () => {
		const links = board.links
			.map((link) => `${link.kind}:${link.from.id}>${link.to.id}`)
			.sort();
		assert.deepEqual(
			links,
			[
				`spawned:${lead}>${worker}`,
				`spawned:agentlive>${fork}`,
				`forked:${lead}>${fork}`,
				`subagent:${lead}>agentlive`,
				`subagent:${lead}>agentdone`,
				`subagent:${lead}>agentidle`,
				`subagent:${lead}>agentflowdone`,
				`subagent:${lead}>agentblocked`,
				`subagent:${lead}>agentflowstopped`,
				`subagent:${fork}>agentorphan`,
				"subagent:agentlive>agentnested",
				"subagent:agentidle>agentinner",
				`subagent:${lead}>bserve`,
				`subagent:${lead}>bbuild`,
				"subagent:agentlive>bwatch",
				"subagent:agentdone>btail",
			].sort(),
		);
	});

	test("matches messages by msg_id, resolves senders by pid and drops ends that left the board", () => {
		assert.deepEqual(
			board.messages.map((message) => [
				message.id,
				message.from.id,
				message.to.id,
				message.summary,
			]),
			[
				["msg-1", lead, worker, "rebase on main"],
				["msg-2", lead, worker, "status?"],
				["msg-3", "agentlive", worker, "hello"],
				[
					`handback:agentlive:${now - 200_000}`,
					"agentlive",
					worker,
					"Listed the files",
				],
			],
		);
		assert.equal(board.messages[0]?.at, now - 569_000);
		assert.equal(board.messages[2]?.from.kind, "subagent");
	});

	test("returns the tail of a transcript", async () => {
		const entries = await handle.transcript(lead, 3);
		assert.deepEqual(
			entries.map((entry) => [entry.role, entry.text]),
			[
				["tool", "Bash: Build once"],
				["assistant", "Now editing."],
				["tool", "Edit: /Users/me/dev/acme-api/src/a.ts"],
			],
		);
		const first = await handle.transcript(lead, 100);
		assert.deepEqual(first[0], {
			at: now - 600_000,
			role: "user",
			text: "ship the acme fix",
		});
		const peers = await handle.transcript(worker, 10);
		assert.equal(peers[0]?.role, "peer");
		assert.equal(peers[0]?.text, "acme-lead: please rebase");
		assert.deepEqual(await handle.transcript("no-such-session", 5), []);
	});

	test("lists recent cwds, most recent first", () => {
		assert.deepEqual(handle.recentCwds(), [
			"/Users/me/dev/acme-api",
			"/Users/me/dev/acme-web",
			"/Users/me/dev/acme-old",
		]);
	});

	test("reports only real changes, debounced", async () => {
		assert.equal(changes.length, 0);
		appendFileSync(
			join(home, `projects/${leadDir}/${lead}.jsonl`),
			`${JSON.stringify(
				assistant(1000, [
					{
						type: "tool_use",
						id: "t-late",
						name: "Bash",
						input: { command: "npm test\nnpm run lint" },
					},
				]),
			)}\n`,
		);
		const deadline = Date.now() + 4000;
		while (changes.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(changes.length, 1);
		const updated = changes[0]?.sessions.find((item) => item.id === lead);
		assert.equal(updated?.doing, "Bash: npm test");
		assert.equal(handle.board(), changes[0]);
		await new Promise((resolve) => setTimeout(resolve, 2400));
		assert.equal(changes.length, 1);
	});
});

describe("goalOf", () => {
	const facts = (aiTitle: string | null, lastPrompt: string | null) => ({
		...createFacts(),
		aiTitle,
		lastPrompt,
	});
	const job = (intent: string | null): Job => ({
		short: "0a1b2c3d",
		sessionId: worker,
		cwd: "/Users/me/dev/acme-web",
		name: null,
		state: null,
		tempo: null,
		detail: null,
		needs: null,
		intent,
		block: null,
		createdAt: 0,
		updatedAt: 0,
	});

	test("prefers the ai title over the last prompt and job intent", () => {
		assert.equal(
			goalOf(facts("Fix checkout", "make it faster"), job("start here")),
			"Fix checkout",
		);
	});

	test("falls back to the last prompt, then the job intent", () => {
		assert.equal(
			goalOf(facts(null, "make it faster"), job("start here")),
			"make it faster",
		);
		assert.equal(goalOf(facts(null, null), job("start here")), "start here");
		assert.equal(goalOf(null, job("start here")), "start here");
	});

	test("reduces a long multi-line prompt to one short line", () => {
		const goal = goalOf(
			facts(
				null,
				`\n\n  fix   the\tbuild ${"and more ".repeat(20)}\nthen deploy`,
			),
			null,
		);
		assert.ok(goal?.startsWith("fix the build and more"));
		assert.ok(!goal?.includes("deploy"));
		assert.equal(goal?.length, 100);
		assert.ok(goal?.endsWith("…"));
	});

	test("is null without a title, prompt or intent", () => {
		assert.equal(goalOf(facts(null, "   \n "), job(null)), null);
		assert.equal(goalOf(null, null), null);
	});
});

describe("startBoard with more subagents than the board shows", () => {
	const swarm = "5a5a5a5a-0000-4000-8000-000000000007";
	const swarmDir = "-Users-me-dev-acme-swarm";
	const subagents = `projects/${swarmDir}/${swarm}/subagents`;
	const extra = 12;
	let board: Board;
	let handle: ReturnType<typeof startBoard>;

	before(() => {
		home = mkdtempSync(join(tmpdir(), "kanban-swarm-"));
		write(`sessions/${process.pid}.json`, {
			pid: process.pid,
			sessionId: swarm,
			cwd: "/Users/me/dev/acme-swarm",
			startedAt: now - 3_600_000,
			kind: "interactive",
			status: "busy",
			updatedAt: now - 1000,
		});
		jsonl(`projects/${swarmDir}/${swarm}.jsonl`, []);
		const steps = Array.from(
			{ length: subagentLimit + extra },
			(_, i) => `agentstep${i}`,
		);
		jsonl(`${subagents}/workflows/wf_9/journal.jsonl`, [
			...steps.map((agentId) => ({ type: "started", agentId })),
			...steps
				.filter((_, i) => i % 2 === 0)
				.map((agentId) => ({ type: "result", agentId, result: "ok" })),
		]);
		steps.forEach((id, i) => {
			const path = `${subagents}/workflows/wf_9/agent-${id}`;
			write(`${path}.meta.json`, {
				agentType: "workflow-subagent",
				description: id,
			});
			jsonl(`${path}.jsonl`, []);
			touch(`${path}.jsonl`, i < 5 ? 5_000 : 600_000 + i * 1000);
		});
		write(`${subagents}/agent-agentlead.meta.json`, {
			agentType: "general-purpose",
			description: "Lead",
		});
		jsonl(`${subagents}/agent-agentlead.jsonl`, [
			result(-1000, "n-agent", {
				agentId: "agentchilddone",
				status: "completed",
			}),
		]);
		touch(`${subagents}/agent-agentlead.jsonl`, 1000);
		for (const child of ["agentchilddone", "agentchildwaiting"]) {
			write(`${subagents}/agent-${child}.meta.json`, {
				agentType: "general-purpose",
				description: child,
				parentAgentId: "agentlead",
			});
			jsonl(`${subagents}/agent-${child}.jsonl`, []);
			touch(`${subagents}/agent-${child}.jsonl`, 900_000);
		}
		handle = startBoard({ claudeHome: home, onChange: () => {} });
		board = handle.board();
	});

	after(() => {
		handle.stop();
		rmSync(home, { recursive: true, force: true });
	});

	test("counts every recent subagent, nested and in workflows, not only the cards shown", () => {
		assert.equal(board.subagents.length, subagentLimit);
		assert.deepEqual(board.subagentCounts, {
			[swarm]: { working: 3, idle: 25, done: 27 },
		});
	});
});
