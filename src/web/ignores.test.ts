import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../shared/types.ts";
import { ignoredSessionIds, ignoreOf, nextMorning } from "./ignores.ts";

test("until tomorrow runs to the next 9am, today's or tomorrow's", () => {
	const local = (d: number, h: number, m = 0, s = 0) =>
		new Date(2026, 10, d, h, m, s).getTime();
	assert.equal(nextMorning(local(1, 8, 59)), local(1, 9));
	assert.equal(nextMorning(local(1, 3)), local(1, 9));
	assert.equal(nextMorning(local(1, 9)), local(2, 9));
	assert.equal(nextMorning(local(1, 9, 0, 1)), local(2, 9));
	assert.equal(nextMorning(local(1, 23, 30)), local(2, 9));
	assert.equal(nextMorning(local(30, 22)), new Date(2026, 11, 1, 9).getTime());
});

function session(id: string, cwd: string): Session {
	return {
		id,
		short: null,
		pid: null,
		name: id,
		cwd,
		project: id,
		kind: "background",
		activity: "needs-you",
		doing: null,
		needs: null,
		goal: null,
		startedAt: 1,
		updatedAt: 1,
		attachable: true,
		cmux: false,
		artifacts: [],
		tasks: [],
		steps: [],
	};
}

const at = 1_000;

test("a project's ignore covers its subdirectories until it runs out", () => {
	const ignores = { "/work/acme": at + 10 };
	assert.deepEqual(ignoreOf(ignores, "/work/acme", at), {
		cwd: "/work/acme",
		until: at + 10,
	});
	assert.deepEqual(ignoreOf(ignores, "/work/acme/.claude/worktrees/x", at), {
		cwd: "/work/acme",
		until: at + 10,
	});
	assert.equal(ignoreOf(ignores, "/work/acme-web", at), null);
	assert.equal(ignoreOf(ignores, "/work/acme", at + 10), null);
});

test("the latest of overlapping ignores wins", () => {
	const ignores = { "/work/acme": at + 10, "/work/acme/api": at + 50 };
	assert.deepEqual(ignoreOf(ignores, "/work/acme/api", at), {
		cwd: "/work/acme/api",
		until: at + 50,
	});
});

test("only sessions inside an ignored project are ignored", () => {
	const sessions = [
		session("a", "/work/acme"),
		session("b", "/work/acme/sub"),
		session("c", "/work/other"),
	];
	assert.deepEqual(
		[...ignoredSessionIds({ "/work/acme": at + 1 }, sessions, at)],
		["a", "b"],
	);
	assert.deepEqual(
		[...ignoredSessionIds({ "/work/acme": at }, sessions, at)],
		[],
	);
});
