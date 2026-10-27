import assert from "node:assert/strict";
import { test } from "node:test";
import { subagentCountsBySession, subagentState } from "../shared/subagents.ts";
import type { Subagent } from "../shared/types.ts";
import {
	sessionsWithWorkingSubagents,
	subagentSummary,
	totalSubagentCounts,
} from "./subagentCounts.ts";

function subagent(
	id: string,
	sessionId: string,
	live: boolean,
	done: boolean,
): Subagent {
	return {
		id,
		sessionId,
		parentAgentId: null,
		type: "general-purpose",
		description: id,
		live,
		done,
		startedAt: 1,
		updatedAt: 1,
	};
}

const agents = [
	subagent("a", "acme-api", true, false),
	subagent("b", "acme-api", false, false),
	subagent("c", "acme-web", true, false),
	subagent("d", "acme-web", false, true),
	subagent("e", "acme-docs", false, true),
];

test("a subagent is working while live, else done once finished, else idle", () => {
	assert.deepEqual(agents.map(subagentState), [
		"working",
		"idle",
		"working",
		"done",
		"done",
	]);
});

test("counts subagents by session and state, and totals them", () => {
	const bySession = subagentCountsBySession(agents);
	assert.deepEqual(bySession, {
		"acme-api": { working: 1, idle: 1, done: 0 },
		"acme-web": { working: 1, idle: 0, done: 1 },
		"acme-docs": { working: 0, idle: 0, done: 1 },
	});
	assert.deepEqual(totalSubagentCounts(bySession), {
		working: 2,
		idle: 1,
		done: 2,
	});
	assert.deepEqual(totalSubagentCounts({}), { working: 0, idle: 0, done: 0 });
});

test("finds the sessions that have a working subagent", () => {
	assert.deepEqual([...sessionsWithWorkingSubagents(agents)].sort(), [
		"acme-api",
		"acme-web",
	]);
});

test("summarises only the states present", () => {
	assert.equal(
		subagentSummary({ working: 2, idle: 0, done: 1 }),
		"3 subagents: 2 working, 1 done",
	);
	assert.equal(
		subagentSummary({ working: 0, idle: 1, done: 0 }),
		"1 subagent: 1 idle",
	);
});
