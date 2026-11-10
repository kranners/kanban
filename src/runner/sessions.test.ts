import assert from "node:assert/strict";
import {
	chmod,
	mkdtemp as makeTemp,
	mkdtemp,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import type { RunnerLaunch } from "../shared/runners.ts";
import type { AccountUsage } from "../shared/types.ts";
import {
	accountSpawn,
	createSessionManager,
	keepSubagentMs,
	mapCwd,
	readStreamLine,
} from "./sessions.ts";

describe("mapCwd", () => {
	const dirs = new Set([
		"/Users/aaron/code/kanban",
		"/home/aaron/code/acme",
		"/srv/work/acme",
	]);
	const opts = {
		hubHome: "/Users/aaron",
		home: "/home/aaron",
		paths: [] as [string, string][],
		isDirectory: (path: string) => dirs.has(path),
		separator: "/",
	};

	it("uses the hub's path when it exists here", () => {
		assert.equal(
			mapCwd("/Users/aaron/code/kanban", opts),
			"/Users/aaron/code/kanban",
		);
	});

	it("moves the hub's home onto this machine's", () => {
		assert.equal(
			mapCwd("/Users/aaron/code/acme", opts),
			"/home/aaron/code/acme",
		);
		assert.equal(
			mapCwd("/Users/aaron/code/acme", {
				...opts,
				home: "C:\\Users\\aaron",
				separator: "\\",
				isDirectory: (path) => path === "C:\\Users\\aaron\\code\\acme",
			}),
			"C:\\Users\\aaron\\code\\acme",
		);
	});

	it("prefers an explicit prefix and refuses what isn't here", () => {
		assert.equal(
			mapCwd("/Users/aaron/code/acme", {
				...opts,
				paths: [["/Users/aaron/code", "/srv/work"]],
			}),
			"/srv/work/acme",
		);
		assert.equal(mapCwd("/Users/aaron/code/gone", opts), null);
		assert.equal(mapCwd("/Users/aaronb/code/acme", opts), null);
	});
});

describe("readStreamLine", () => {
	it("reads the session id, the latest step and the result", () => {
		assert.deepEqual(
			readStreamLine('{"type":"system","subtype":"init","session_id":"abc"}'),
			{ sessionId: "abc" },
		);
		assert.deepEqual(
			readStreamLine(
				JSON.stringify({
					type: "assistant",
					session_id: "abc",
					message: {
						content: [
							{ type: "text", text: "\nLooking at the tests\nmore" },
							{
								type: "tool_use",
								name: "Bash",
								input: { command: "npm test" },
							},
						],
					},
				}),
			),
			{ sessionId: "abc", detail: "Bash: npm test" },
		);
		assert.deepEqual(
			readStreamLine(
				'{"type":"result","subtype":"success","is_error":false,"result":"All green"}',
			),
			{ sessionId: undefined, result: { ok: true, text: "All green" } },
		);
		assert.equal(
			readStreamLine('{"type":"result","subtype":"error_max_turns"}')?.result
				?.ok,
			false,
		);
		assert.equal(readStreamLine("not json"), null);
	});

	it("leaves a subagent's steps out of the session's detail", () => {
		assert.deepEqual(
			readStreamLine(
				JSON.stringify({
					type: "assistant",
					session_id: "abc",
					parent_tool_use_id: "toolu_1",
					message: { content: [{ type: "text", text: "Inside the agent" }] },
				}),
			),
			{ sessionId: "abc" },
		);
	});

	it("notes the session's own Agent and Workflow calls and their ends", () => {
		const line = (event: unknown) => readStreamLine(JSON.stringify(event));
		assert.deepEqual(
			line({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "toolu_1",
							name: "Agent",
							input: { description: "Find it", subagent_type: "Explore" },
						},
						{
							type: "tool_use",
							id: "toolu_2",
							name: "Task",
							input: { description: "x".repeat(300), run_in_background: true },
						},
						{ type: "tool_use", id: "toolu_3", name: "Workflow", input: {} },
						{ type: "tool_use", id: "toolu_4", name: "Bash", input: {} },
						{ type: "tool_use", id: "bad id", name: "Agent", input: {} },
					],
				},
			})?.agentStarts,
			[
				{
					id: "toolu_1",
					description: "Find it",
					type: "Explore",
				},
				{
					id: "toolu_2",
					description: `${"x".repeat(199)}…`,
					type: "general-purpose",
				},
				{
					id: "toolu_3",
					description: "Workflow",
					type: "workflow",
				},
			],
		);
		assert.deepEqual(
			line({
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1" },
						{ type: "tool_result", tool_use_id: "toolu_2", is_error: true },
						{
							type: "tool_result",
							tool_use_id: "toolu_5",
							content: [
								{ type: "text", text: "Async agent launched successfully." },
							],
						},
					],
				},
			})?.agentEnds,
			[
				{ id: "toolu_1", final: true },
				{ id: "toolu_2", final: true },
				{ id: "toolu_5", final: false },
			],
		);
		assert.deepEqual(
			line({
				type: "user",
				tool_use_result: { status: "async_launched", agentId: "a1" },
				message: { content: [{ type: "tool_result", tool_use_id: "toolu_6" }] },
			})?.agentEnds,
			[{ id: "toolu_6", final: false }],
		);
		assert.deepEqual(
			line({
				type: "system",
				subtype: "task_notification",
				tool_use_id: "toolu_3",
			})?.agentEnds,
			[{ id: "toolu_3", final: true }],
		);
		assert.equal(
			line({
				type: "user",
				parent_tool_use_id: "toolu_1",
				message: { content: [{ type: "tool_result", tool_use_id: "toolu_9" }] },
			})?.agentEnds,
			undefined,
		);
	});
});

describe("createSessionManager", { skip: process.platform === "win32" }, () => {
	let dir = "";
	let fake = "";

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "kanban-runner-"));
		fake = join(dir, "fake-claude.mjs");
		await writeFile(
			fake,
			`
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
	const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
	out({ type: "system", subtype: "init", session_id: "claude-1" });
	out({ type: "assistant", message: { content: [{ type: "text", text: "on " + process.cwd() } ] } });
	if (prompt === "agents") {
		const call = (id, name, input) => ({ type: "tool_use", id, name, input });
		const answer = (id, status = "completed") => out({ type: "user", tool_use_result: { status }, message: { content: [{ type: "tool_result", tool_use_id: id }] } });
		out({ type: "assistant", message: { content: [
			call("toolu_fg", "Agent", { description: "Look", subagent_type: "Explore" }),
			call("toolu_bg", "Agent", { description: "Wait" }),
			call("toolu_wf", "Workflow", { description: "Plan" }),
		] } });
		out({ type: "assistant", parent_tool_use_id: "toolu_fg", message: { content: [call("toolu_in", "Agent", {})] } });
		answer("toolu_fg");
		answer("toolu_bg", "async_launched");
		answer("toolu_wf", "async_launched");
		out({ type: "system", subtype: "task_notification", tool_use_id: "toolu_wf" });
	}
	if (prompt === "hang" || prompt === "agents") { setInterval(() => {}, 1000); return; }
	if (prompt === "fail") { process.stderr.write("boom\\n"); process.exit(3); }
	out({ type: "result", subtype: "success", is_error: false, result: "did " + prompt });
});
`,
		);
	});

	const launchOf = (id: string, prompt: string, cwd = dir): RunnerLaunch => ({
		type: "launch",
		commandId: `c-${id}`,
		session: { id, cwd, prompt, name: `name ${id}` },
		hubHome: null,
	});

	const settled = async (
		manager: ReturnType<typeof createSessionManager>,
		id: string,
	) => {
		for (let i = 0; i < 200; i++) {
			const session = manager.list().find((s) => s.id === id);
			if (session?.endedAt) return session;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`${id} never finished`);
	};

	const managerFor = () =>
		createSessionManager({
			claude: { file: process.execPath, args: [fake] },
			stopGraceMs: 500,
		});

	it("runs a prompt to its result in the asked-for directory", async () => {
		const manager = managerFor();
		assert.deepEqual(await manager.launch(launchOf("s1", "the thing")), {
			ok: true,
		});
		const session = await settled(manager, "s1");
		assert.equal(session.state, "done");
		assert.equal(session.detail, "did the thing");
		assert.equal(session.claudeSessionId, "claude-1");
		assert.equal(session.localCwd, dir);
		assert.equal(session.name, "name s1");
	});

	it("reports a failure with claude's last error line", async () => {
		const manager = managerFor();
		await manager.launch(launchOf("s2", "fail"));
		const session = await settled(manager, "s2");
		assert.equal(session.state, "failed");
		assert.equal(session.detail, "boom");
	});

	it("stops a running session, and forgets an ended one", async () => {
		const manager = managerFor();
		await manager.launch(launchOf("s3", "hang"));
		assert.equal(manager.pids().has("s3"), true);
		assert.deepEqual(await manager.stop("s3", false), { ok: true });
		const session = await settled(manager, "s3");
		assert.equal(session.state, "stopped");
		assert.equal(manager.pids().has("s3"), false);
		await manager.stop("s3", false);
		assert.equal(
			manager.list().some((s) => s.id === "s3"),
			false,
		);
	});

	it("refuses a directory that isn't here, and a claude that won't start", async () => {
		const manager = managerFor();
		const missing = await manager.launch(launchOf("s4", "x", "/no/such/dir"));
		assert.equal(missing.ok, false);
		const broken = createSessionManager({
			claude: { file: join(dir, "no-claude"), args: [] },
		});
		const result = await broken.launch(launchOf("s5", "x"));
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /Couldn't start claude/);
	});

	it("reports its own subagents, ending a backgrounded one with its notification or the session", async () => {
		const manager = managerFor();
		await manager.launch(launchOf("s7", "agents"));
		const states = () =>
			Object.fromEntries(
				(manager.list().find((s) => s.id === "s7")?.subagents ?? []).map(
					(agent) => [agent.id, `${agent.type} ${agent.state}`],
				),
			);
		for (let i = 0; i < 200 && states().toolu_wf !== "workflow done"; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(states(), {
			toolu_bg: "general-purpose working",
			toolu_fg: "Explore done",
			toolu_wf: "workflow done",
		});
		await manager.stop("s7", false);
		await settled(manager, "s7");
		assert.deepEqual(states(), {
			toolu_bg: "general-purpose done",
			toolu_fg: "Explore done",
			toolu_wf: "workflow done",
		});
	});

	it("drops finished subagents after half an hour", async () => {
		let at = 1_000;
		const manager = createSessionManager({
			claude: { file: process.execPath, args: [fake] },
			now: () => at,
			stopGraceMs: 500,
		});
		await manager.launch(launchOf("s8", "agents"));
		const count = () =>
			manager.list().find((s) => s.id === "s8")?.subagents?.length ?? 0;
		for (let i = 0; i < 200 && count() < 3; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		await manager.stop("s8", false);
		await settled(manager, "s8");
		assert.equal(count(), 3);
		at += keepSubagentMs + 1;
		assert.equal(
			manager.list().find((s) => s.id === "s8")?.subagents,
			undefined,
		);
	});

	it("keeps only recent finished sessions", async () => {
		let at = 1_000;
		const manager = createSessionManager({
			claude: { file: process.execPath, args: [fake] },
			now: () => at,
			keepFinishedMs: 100,
		});
		await manager.launch(launchOf("s6", "quick"));
		await settled(manager, "s6");
		at += 1_000;
		assert.equal(manager.list().length, 0);
	});
});

const account = (
	number: number,
	week: number,
	extra: Partial<AccountUsage> = {},
): AccountUsage => ({
	id: `a${number}`,
	number,
	email: `a${number}@example.com`,
	alias: `ap${number}`,
	organization: "",
	configDir: `/profiles/${number}`,
	isDefault: number === 1,
	session: { percent: 10, resetsAt: null },
	week: { percent: week, resetsAt: null },
	samples: [],
	error: null,
	blocked: null,
	...extra,
});

describe("accountSpawn", () => {
	const claude = { file: "/opt/claude/bin/claude", args: ["--x"] };
	it("runs plain claude on the default login and cswap run on a profile", () => {
		assert.deepEqual(accountSpawn(claude, "cswap", account(1, 0), ["-p"], {}), {
			file: "/opt/claude/bin/claude",
			args: ["-p"],
			env: {},
		});
		assert.deepEqual(
			accountSpawn(claude, "cswap", account(2, 0), ["-p"], {
				PATH: "/usr/bin",
			}),
			{
				file: "cswap",
				args: ["run", "2", "--share-history", "--", "-p"],
				env: { PATH: "/opt/claude/bin:/usr/bin" },
			},
		);
	});
});

describe("runner account failover", {
	skip: process.platform === "win32",
}, () => {
	let dir = "";
	let fake = "";
	let cswap = "";

	before(async () => {
		dir = await makeTemp(join(tmpdir(), "kanban-failover-"));
		fake = join(dir, "fake-claude.mjs");
		cswap = join(dir, "fake-cswap");
		// Hits a weekly limit on the default login; works on any cswap profile.
		await writeFile(
			fake,
			`
process.stdin.resume();
process.stdin.on("end", () => {
	const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
	const on = process.env.FAKE_ACCOUNT;
	const resumed = process.argv.includes("--resume");
	out({ type: "system", subtype: "init", session_id: "claude-9" });
	if (!on) {
		out({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit · resets Nov 6 at 10pm" });
		return;
	}
	out({ type: "result", subtype: "success", is_error: false, result: "resumed " + resumed + " on account " + on });
});
`,
		);
		await writeFile(
			cswap,
			`#!/bin/sh\nn=$2\nshift 4\nFAKE_ACCOUNT=$n exec "${process.execPath}" "$@"\n`,
		);
		await chmod(cswap, 0o755);
	});

	const launchOf = (id: string): RunnerLaunch => ({
		type: "launch",
		commandId: `c-${id}`,
		session: { id, cwd: dir, prompt: "go", name: id },
		hubHome: null,
	});

	const settled = async (
		manager: ReturnType<typeof createSessionManager>,
		id: string,
	) => {
		for (let i = 0; i < 300; i++) {
			const session = manager.list().find((s) => s.id === id);
			if (session?.endedAt) return session;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`${id} never finished`);
	};

	it("resumes a session that hit its limit on the account with most headroom", async () => {
		const manager = createSessionManager({
			claude: { file: process.execPath, args: [fake] },
			accounts: {
				cswap,
				list: async () => [account(1, 10), account(2, 40), account(3, 30)],
			},
		});
		await manager.launch(launchOf("f1"));
		const session = await settled(manager, "f1");
		assert.equal(session.detail, "resumed true on account 3");
		assert.equal(session.state, "done");
		assert.equal(session.detail, "resumed true on account 3");
	});

	it("says so when every other account is spent or held out", async () => {
		const manager = createSessionManager({
			claude: { file: process.execPath, args: [fake] },
			accounts: {
				cswap,
				list: async () => [
					account(1, 10),
					account(2, 99),
					account(3, 10, { disabled: true }),
				],
			},
		});
		await manager.launch(launchOf("f2"));
		const session = await settled(manager, "f2");
		assert.equal(session.state, "failed");
		assert.match(
			session.detail ?? "",
			/Every Claude account on this machine is at its limit/,
		);
	});
});
