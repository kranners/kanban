import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Subagent, Workflow } from "../shared/types.ts";
import {
	chipName,
	orderWorkflows,
	subagentChips,
	workflowDetail,
} from "./subagentChips.ts";

const agent = (id: string, updatedAt: number, extra: Partial<Subagent> = {}) =>
	({
		id,
		kind: "agent",
		sessionId: "s1",
		parentAgentId: null,
		type: "general-purpose",
		description: `Agent ${id}`,
		live: false,
		done: false,
		startedAt: 0,
		updatedAt,
		...extra,
	}) satisfies Subagent;

const run = (runId: string, extra: Partial<Workflow> = {}): Workflow => ({
	runId,
	sessionId: "s1",
	name: runId,
	done: 0,
	total: 0,
	...extra,
});

describe("subagentChips", () => {
	test("shows the session's newest agents and counts the rest", () => {
		const chips = subagentChips(
			[
				agent("a", 1),
				agent("b", 5),
				agent("c", 3, { done: true }),
				agent("d", 4),
				agent("e", 2),
				agent("other", 9, { sessionId: "s2" }),
				agent("shell", 10, { kind: "shell" }),
			],
			"s1",
			{ working: 1, idle: 3, done: 3 },
		);
		assert.deepEqual(
			chips.shown.map((subagent) => subagent.id),
			["b", "d", "c", "e"],
		);
		assert.equal(chips.more, 3);
	});

	test("counts the agents it has when the board sent no counts", () => {
		const chips = subagentChips(
			[agent("a", 1), agent("b", 2)],
			"s1",
			undefined,
			1,
		);
		assert.deepEqual(
			chips.shown.map((subagent) => subagent.id),
			["b"],
		);
		assert.equal(chips.more, 1);
	});

	test("shows nothing for a session without agents", () => {
		assert.deepEqual(subagentChips([], "s1", undefined), {
			shown: [],
			more: 0,
		});
	});
});

describe("chipName", () => {
	test("uses the description, else the type, clipped", () => {
		assert.equal(chipName(agent("a", 0)), "Agent a");
		assert.equal(
			chipName(agent("a", 0, { description: " ", type: "Explore" })),
			"Explore",
		);
		const long = chipName(agent("a", 0, { description: "x".repeat(60) }));
		assert.equal(long.length, 28);
		assert.ok(long.endsWith("…"));
	});
});

describe("workflowDetail", () => {
	test("gives progress and agents while running, agents and done after", () => {
		const runs = { wf: ["a1", "a2", "a3", "a4", "a5", "a6"] };
		assert.equal(
			workflowDetail(run("wf", { done: 2, total: 6 }), runs),
			"2/6 · 6 agents",
		);
		assert.equal(
			workflowDetail(run("wf", { done: 6, total: 6, endedAt: 5 }), runs),
			"6 agents · done",
		);
	});

	test("leaves out what it cannot count", () => {
		assert.equal(workflowDetail(run("wf"), {}), "");
		assert.equal(workflowDetail(run("wf", { endedAt: 1 }), {}), "done");
		assert.equal(workflowDetail(run("wf", { total: 1 }), {}), "0/1 · 1 agent");
	});
});

describe("orderWorkflows", () => {
	test("puts running runs first, then the most recently ended", () => {
		assert.deepEqual(
			orderWorkflows([
				run("old", { endedAt: 1 }),
				run("live"),
				run("new", { endedAt: 5 }),
			]).map((workflow) => workflow.runId),
			["live", "new", "old"],
		);
	});
});
