import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "../shared/types.ts";
import {
	type ExitDeps,
	exitSession,
	parseProcessInfo,
	parseReadiness,
	type Readiness,
	readinessArgs,
	sameProcess,
} from "./exit.ts";

const background: Session = {
	id: "11111111-2222-3333-4444-555555555555",
	short: "abcd1234",
	pid: 42,
	name: "acme-api",
	cwd: "/Users/me/dev/acme-api",
	project: "acme-api",
	kind: "background",
	activity: "idle",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: true,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
};

const interactive: Session = {
	...background,
	short: null,
	kind: "interactive",
	attachable: false,
};

const fakeDeps = (
	readiness: Readiness,
	removeOk = true,
	stopOk = true,
	archiveOk = true,
): { deps: ExitDeps; calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			ask: async (session) => {
				calls.push(`ask ${session.id}`);
				return readiness;
			},
			stop: async ({ short }) => {
				calls.push(`stop ${short}`);
				return stopOk
					? { ok: true, output: "" }
					: { ok: false, output: "no such job" };
			},
			remove: async ({ short }) => {
				calls.push(`rm ${short}`);
				return removeOk
					? { ok: true, output: "" }
					: { ok: false, output: "worktree has unpushed commits" };
			},
			terminate: async (session) => {
				calls.push(`term ${session.pid}`);
				return { ok: true, output: "" };
			},
			archive: async (id) => {
				calls.push(`archive ${id}`);
				return archiveOk
					? { ok: true, value: null }
					: { ok: false, error: "Cloud API failed with HTTP 500" };
			},
		},
	};
};

const ready: Readiness = { ok: true, ready: true, reason: "All done" };
const notReady: Readiness = { ok: true, ready: false, reason: "Tests running" };

describe("exitSession", () => {
	it("asks, then stops and removes a ready background session", async () => {
		const { deps, calls } = fakeDeps(ready);
		assert.deepEqual(await exitSession(deps, background, false), {
			ok: true,
			exited: true,
		});
		assert.deepEqual(calls, [
			`ask ${background.id}`,
			"stop abcd1234",
			"rm abcd1234",
		]);
	});

	it("archives a cloud session only when forced, since it can't be asked", async () => {
		const cloud: Session = {
			...background,
			id: "session_01cloud",
			short: null,
			pid: null,
			attachable: false,
			cloud: { url: "https://claude.ai/code/session_01cloud" },
		};
		const { deps, calls } = fakeDeps(ready);
		const unforced = await exitSession(deps, cloud, false);
		assert.equal(unforced.ok && unforced.exited, false);
		assert.deepEqual(calls, []);
		assert.deepEqual(await exitSession(deps, cloud, true), {
			ok: true,
			exited: true,
		});
		assert.deepEqual(calls, ["archive session_01cloud"]);
		const failing = fakeDeps(ready, true, true, false);
		assert.deepEqual(await exitSession(failing.deps, cloud, true), {
			ok: false,
			error: "Cloud API failed with HTTP 500",
		});
	});

	it("leaves a session that is not ready alone", async () => {
		const { deps, calls } = fakeDeps(notReady);
		assert.deepEqual(await exitSession(deps, background, false), {
			ok: true,
			exited: false,
			reason: "Tests running",
		});
		assert.deepEqual(calls, [`ask ${background.id}`]);
	});

	it("skips the question when forced", async () => {
		const { deps, calls } = fakeDeps(notReady);
		await exitSession(deps, background, true);
		assert.deepEqual(calls, ["stop abcd1234", "rm abcd1234"]);
	});

	it("reports a refused rm after stopping", async () => {
		const { deps } = fakeDeps(ready, false);
		assert.deepEqual(await exitSession(deps, background, true), {
			ok: false,
			error: "Stopped, but claude rm refused: worktree has unpushed commits",
		});
	});

	it("does not remove a session that claude stop failed to stop", async () => {
		const { deps, calls } = fakeDeps(ready, true, false);
		assert.deepEqual(await exitSession(deps, background, true), {
			ok: false,
			error: "claude stop failed: no such job",
		});
		assert.deepEqual(calls, ["stop abcd1234"]);
	});

	it("terminates an interactive session instead of using claude stop", async () => {
		const { deps, calls } = fakeDeps(ready);
		await exitSession(deps, interactive, false);
		assert.deepEqual(calls, [`ask ${interactive.id}`, "term 42"]);
		const { deps: gone } = fakeDeps(ready);
		assert.equal(
			(await exitSession(gone, { ...interactive, pid: null }, true)).ok,
			false,
		);
	});

	it("passes a failed question through without exiting", async () => {
		const { deps, calls } = fakeDeps({ ok: false, error: "no answer" });
		assert.deepEqual(await exitSession(deps, background, false), {
			ok: false,
			error: "no answer",
		});
		assert.equal(calls.length, 1);
	});
});

describe("readiness", () => {
	it("asks a fork that cannot run tools or persist", () => {
		const args = readinessArgs("sess-1", "fork-1");
		assert.deepEqual(args.slice(0, 9), [
			"-p",
			"--resume",
			"sess-1",
			"--fork-session",
			"--session-id",
			"fork-1",
			"--no-session-persistence",
			"--tools",
			"",
		]);
		assert.equal(args.at(-2), "--");
	});

	it("loads no MCP servers or hooks and never runs a tool unasked", () => {
		const args = readinessArgs("sess-1", "fork-1");
		assert.ok(args.includes("--strict-mcp-config"));
		assert.ok(!args.includes("--mcp-config"));
		assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
		assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1] ?? ""), {
			disableAllHooks: true,
		});
	});

	it("reads structured output from claude -p json", () => {
		const output = JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: '{"ready":false,"reason":"Waiting on CI"}',
			structured_output: { ready: false, reason: " Waiting on CI " },
		});
		assert.deepEqual(parseReadiness(output), {
			ok: true,
			ready: false,
			reason: "Waiting on CI",
		});
	});

	it("explains failures", () => {
		assert.deepEqual(parseReadiness("", "No conversation found\n"), {
			ok: false,
			error: "Could not ask the session: No conversation found",
		});
		assert.deepEqual(
			parseReadiness(
				JSON.stringify({ is_error: true, result: "Credit balance too low" }),
			),
			{
				ok: false,
				error: "The session did not answer: Credit balance too low",
			},
		);
	});
});

describe("process identity", () => {
	const startedAt = new Date("Sat Oct 24 10:32:40 2026").getTime();

	it("reads ps lstart and command", () => {
		assert.deepEqual(
			parseProcessInfo(
				"Sat Oct 24 10:32:40 2026    /opt/homebrew/bin/claude\n",
			),
			{ startedAt, command: "/opt/homebrew/bin/claude" },
		);
		assert.equal(parseProcessInfo(""), null);
	});

	it("accepts the claude process that wrote the registry entry", () => {
		const info = { startedAt, command: "/opt/homebrew/bin/claude" };
		assert.ok(sameProcess({ startedAt: startedAt + 1400 }, info));
		assert.ok(sameProcess({ startedAt }, { ...info, command: "claude" }));
	});

	it("refuses a reused pid", () => {
		const info = { startedAt, command: "/opt/homebrew/bin/claude" };
		assert.ok(!sameProcess({ startedAt: startedAt - 3_600_000 }, info));
		assert.ok(!sameProcess({ startedAt: startedAt + 3_600_000 }, info));
		assert.ok(!sameProcess({ startedAt }, { startedAt, command: "/bin/zsh" }));
		assert.ok(!sameProcess({ startedAt }, null));
	});
});
