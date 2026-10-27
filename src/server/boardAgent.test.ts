import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createAgentTokens } from "./agentAuth.ts";
import {
	type AgentProcess,
	agentArgs,
	agentMarker,
	applyStreamEvent,
	createBoardAgent,
	isAgentDir,
} from "./boardAgent.ts";
import { createCommentStore } from "./comments.ts";

type FakeRun = {
	args: string[];
	env: NodeJS.ProcessEnv;
	stdout: PassThrough;
	stderr: PassThrough;
	exit(code: number | null): void;
	killed: string[];
};

const setup = async () => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-agent-"));
	const store = createCommentStore({
		file: join(dir, "comments.json"),
		initial: [],
		onChange: () => {},
		onRemove: () => {},
	});
	const runs: FakeRun[] = [];
	const agent = createBoardAgent({
		store,
		tokens: createAgentTokens(60_000),
		boardUrl: "http://127.0.0.1:1",
		mcpScript: "/repo/src/agent/mcp.ts",
		node: "/usr/bin/node",
		timeoutMs: 60_000,
		spawn: (args, env) => {
			const events = new EventEmitter();
			const run: FakeRun = {
				args,
				env,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				exit: (code) => events.emit("exit", code),
				killed: [],
			};
			runs.push(run);
			return {
				stdout: run.stdout,
				stderr: run.stderr,
				kill: (signal: string) => {
					run.killed.push(signal);
					setImmediate(() => run.exit(null));
					return true;
				},
				on: (event: string, listener: (...args: unknown[]) => void) => {
					events.on(event, listener);
					return undefined;
				},
			} as unknown as AgentProcess;
		},
	});
	return { store, agent, runs };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));
const send = (run: FakeRun, value: object) =>
	run.stdout.write(`${JSON.stringify(value)}\n`);

describe("board agent", () => {
	it("owns its threads' sessions before the run starts, so ingest skips them", async () => {
		const { store, agent, runs } = await setup();
		const thread = store.create({ x: 0, y: 0, text: "hi" });
		assert.ok(thread);
		assert.ok(agent.owns(thread.sessionId));
		agent.ask(thread.id, "hi");
		assert.ok(runs[0]?.args.includes(thread.sessionId));
		assert.equal(agent.owns("0c0c0c0c-0000-4000-8000-000000000006"), false);
	});

	it("runs a turn, streams actions into the thread and resumes the next turn", async () => {
		const { store, agent, runs } = await setup();
		const thread = store.create({ x: 0, y: 0, text: "organise" });
		assert.ok(thread);
		assert.deepEqual(agent.ask(thread.id, "organise"), { ok: true });
		assert.equal(store.get(thread.id)?.running, true);
		assert.deepEqual(agent.ask(thread.id, "again"), {
			error: "The agent is still working on this thread",
			status: 409,
		});
		const run = runs[0];
		assert.ok(run);
		assert.ok(run.args.includes("--session-id"));
		assert.equal(run.args.at(-1), "organise");
		assert.match(run.env.KANBAN_AGENT_TOKEN ?? "", /^[A-Za-z0-9_-]{43}$/);
		send(run, {
			type: "system",
			subtype: "init",
			session_id: thread.sessionId,
		});
		send(run, {
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "mcp__kanban__arrange",
						input: {},
					},
				],
			},
		});
		send(run, {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "Moved 6 cards\n{}",
					},
				],
			},
		});
		send(run, {
			type: "assistant",
			message: {
				content: [{ type: "text", text: "Grouped into 2 projects." }],
			},
		});
		send(run, {
			type: "result",
			subtype: "success",
			result: "Grouped into 2 projects.",
		});
		await tick();
		run.exit(0);
		const done = store.get(thread.id);
		assert.equal(done?.running, false);
		assert.equal(done?.resumable, true);
		assert.deepEqual(
			done?.events.map(({ kind, text }) => [kind, text]),
			[
				["user", "organise"],
				["action", "Moved 6 cards"],
				["reply", "Grouped into 2 projects."],
			],
		);
		agent.ask(thread.id, "and tidy notes");
		assert.deepEqual(runs[1]?.args.slice(4, 6), ["--resume", thread.sessionId]);
	});

	it("reports a run that dies without a result, and cancels on request", async () => {
		const { store, agent, runs } = await setup();
		const thread = store.create({ x: 0, y: 0, text: "x" });
		assert.ok(thread);
		agent.ask(thread.id, "x");
		runs[0]?.stderr.write("Error: no auth\n");
		await tick();
		runs[0]?.exit(1);
		assert.deepEqual(store.get(thread.id)?.events.at(-1), {
			kind: "error",
			at: store.get(thread.id)?.events.at(-1)?.at,
			text: "The agent stopped: Error: no auth",
		});
		agent.ask(thread.id, "y");
		assert.ok(agent.cancel(thread.id));
		await tick();
		await tick();
		assert.deepEqual(runs[1]?.killed, ["SIGTERM"]);
		const cancelled = store.get(thread.id);
		assert.equal(cancelled?.running, false);
		assert.equal(cancelled?.events.at(-1)?.text, "Cancelled");
		assert.equal(agent.cancel(thread.id), false);
	});

	it("stops every run when the server shuts down", async () => {
		const { store, agent, runs } = await setup();
		const threads = [
			store.create({ x: 0, y: 0, text: "a" }),
			store.create({ x: 0, y: 0, text: "b" }),
		];
		for (const thread of threads) if (thread) agent.ask(thread.id, "go");
		agent.stopAll();
		await tick();
		await tick();
		assert.deepEqual(
			runs.map((run) => run.killed),
			[["SIGTERM"], ["SIGTERM"]],
		);
		for (const thread of threads) {
			const stopped = thread && store.get(thread.id);
			assert.equal(stopped?.running, false);
			assert.match(stopped?.events.at(-1)?.text ?? "", /server stopped/);
		}
	});

	it("knows its own working directory by a marker any server can see", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-agent-dir-"));
		assert.equal(isAgentDir(dir), false);
		await writeFile(join(dir, agentMarker), "");
		assert.equal(isAgentDir(dir), true);
	});

	it("allows only the board's own tools", () => {
		const args = agentArgs({ sessionId: "s", resumable: false }, "hi", "{}");
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		assert.equal(after("--tools"), "");
		assert.equal(after("--allowedTools"), "mcp__kanban");
		assert.equal(after("--permission-mode"), "dontAsk");
		assert.ok(args.includes("--strict-mcp-config"));
		assert.deepEqual(JSON.parse(after("--settings") ?? ""), {
			disableAllHooks: true,
		});
		assert.ok(!args.includes("--dangerously-skip-permissions"));
	});

	it("marks failed tool calls", () => {
		const thread = {
			id: "t",
			x: 0,
			y: 0,
			createdAt: 0,
			updatedAt: 0,
			resolved: false,
			running: true,
			sessionId: "s",
			resumable: true,
			events: [],
		};
		const started = applyStreamEvent(
			thread,
			{
				kind: "tool-start",
				id: "u1",
				name: "mcp__kanban__finish_session",
				input: {},
			},
			1,
		);
		assert.deepEqual(started.events, [
			{
				kind: "action",
				at: 1,
				id: "u1",
				text: "Finishing a session",
				state: "running",
			},
		]);
		const ended = applyStreamEvent(
			started,
			{
				kind: "tool-end",
				id: "u1",
				text: "acme is already exiting",
				isError: true,
			},
			2,
		);
		assert.deepEqual(ended.events, [
			{
				kind: "action",
				at: 1,
				id: "u1",
				text: "Finishing a session failed: acme is already exiting",
				state: "failed",
			},
		]);
	});
});
