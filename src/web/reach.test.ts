import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../shared/types.ts";
import type { Group } from "./groups.ts";
import { unreachablePeers, unreachableText } from "./reach.ts";

function session(id: string, patch: Partial<Session> = {}): Session {
	return {
		id,
		short: null,
		pid: 1,
		name: id,
		cwd: "/dev/acme",
		project: "acme",
		kind: "background",
		activity: "working",
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
		...patch,
	};
}

function project(...ids: string[]): Group {
	return {
		key: `region:${ids.join("-")}`,
		project: "acme",
		cwd: "/dev/acme",
		members: ids.map((id) => `session:${id}` as const),
		frame: { x: 0, y: 0, w: 0, h: 0 },
	};
}

test("live sessions in one project on different accounts can't reach each other", () => {
	const sessions = [
		session("a"),
		session("b"),
		session("c", { configDir: "/profiles/2" }),
		session("gone", { configDir: "/profiles/3", pid: null }),
		session("elsewhere", { configDir: "/profiles/2" }),
	];
	const unreachable = unreachablePeers(
		[project("a", "b", "c", "gone")],
		sessions,
	);
	assert.deepEqual(
		Object.fromEntries(
			[...unreachable].map(([id, others]) => [id, others.map((s) => s.id)]),
		),
		{ a: ["c"], b: ["c"], c: ["a", "b"] },
	);
});

test("one account per project warns no one", () => {
	const sessions = [session("a"), session("b")];
	assert.equal(unreachablePeers([project("a", "b")], sessions).size, 0);
});

test("the warning names the sessions out of reach", () => {
	assert.equal(
		unreachableText([session("api-auth")]),
		"Can't message api-auth in this project: it runs on another Claude account, and sessions can only message sessions on their own account.",
	);
});
