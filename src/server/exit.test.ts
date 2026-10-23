import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "../shared/types.ts";
import {
	type ExitDeps,
	exitSession,
	parseReadiness,
	type Readiness,
	readinessArgs,
	sessionExiter,
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
	startedAt: 0,
	updatedAt: 0,
	attachable: true,
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
): { deps: ExitDeps; calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			ask: async (session) => {
				calls.push(`ask ${session.id}`);
				return readiness;
			},
			stop: async (short) => {
				calls.push(`stop ${short}`);
				return { ok: true, output: "" };
			},
			remove: async (short) => {
				calls.push(`rm ${short}`);
				return removeOk
					? { ok: true, output: "" }
					: { ok: false, output: "worktree has unpushed commits" };
			},
			terminate: async (session) => {
				calls.push(`term ${session.pid}`);
				return { ok: true, output: "" };
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

	it("refuses a second exit of the same session while one runs", async () => {
		let release = () => {};
		const { deps } = fakeDeps(ready);
		const exiter = sessionExiter({
			...deps,
			ask: () =>
				new Promise((resolve) => {
					release = () => resolve(ready);
				}),
		});
		const first = exiter(background, false);
		assert.deepEqual(await exiter(background, true), {
			ok: false,
			error: "This session is already exiting",
		});
		release();
		assert.deepEqual(await first, { ok: true, exited: true });
	});
});

describe("readiness", () => {
	it("asks a fork that cannot run tools or persist", () => {
		const args = readinessArgs("sess-1", "fork-1");
		assert.deepEqual(args.slice(0, 11), [
			"-p",
			"--resume",
			"sess-1",
			"--fork-session",
			"--session-id",
			"fork-1",
			"--no-session-persistence",
			"--tools",
			"",
			"--output-format",
			"json",
		]);
		assert.equal(args.at(-2), "--");
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
