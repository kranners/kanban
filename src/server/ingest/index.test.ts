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
import { startBoard } from "./index.ts";

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
	);
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
			startedAt: now - 3_600_000,
			updatedAt: now - 60_000,
			attachable: false,
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
		assert.equal(item.attachable, true);
	});

	test("lists recent subagents as working, idle or done", () => {
		const states = Object.fromEntries(
			board.subagents.map((item) => [item.id, [item.live, item.done]]),
		);
		assert.deepEqual(states, {
			agentlive: [true, false],
			agentnested: [true, false],
			agentdone: [false, true],
			agentflowdone: [false, true],
			agentidle: [false, false],
		});
		const nested = board.subagents.find((item) => item.id === "agentnested");
		assert.equal(nested?.parentAgentId, "agentlive");
		assert.equal(nested?.sessionId, lead);
		assert.equal(nested?.type, "fork");
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
				"subagent:agentlive>agentnested",
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
				["tool", "SendMessage"],
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
