import assert from "node:assert/strict";
import { test } from "node:test";
import type { Subagent } from "../../shared/types.ts";
import { createFacts } from "./records.ts";
import {
	type FoundSubagent,
	newestPerSession,
	settleSubagents,
	subagentLimit,
} from "./subagents.ts";

function found(
	id: string,
	sessionId: string,
	updatedAt: number,
	state: Partial<Subagent> = {},
): FoundSubagent {
	return {
		transcriptPath: `/agents/${id}.jsonl`,
		subagent: {
			id,
			sessionId,
			parentAgentId: null,
			type: "general-purpose",
			description: id,
			live: false,
			done: false,
			startedAt: 0,
			updatedAt,
			...state,
		},
	};
}

test("keeps the newest subagents of each session up to the limit", () => {
	const many = Array.from({ length: subagentLimit + 20 }, (_, i) =>
		found(`a${i}`, "busy", i),
	);
	const shown = newestPerSession([...many, found("quiet", "calm", 0)]);
	const busy = shown.filter(({ subagent }) => subagent.sessionId === "busy");
	assert.equal(busy.length, subagentLimit);
	assert.equal(busy.at(-1)?.subagent.id, "a20");
	assert.ok(shown.some(({ subagent }) => subagent.id === "quiet"));
});

test("a subagent waiting on a tool is working; one any transcript finished is done", () => {
	const parent = createFacts();
	parent.finishedTasks.add("nested");
	const blocked = createFacts();
	blocked.tools.set("t1", { name: "Bash", input: {} });
	const settled = settleSubagents(
		[
			found("parent", "s", 1),
			found("nested", "s", 1, { parentAgentId: "parent" }),
			found("blocked", "s", 1),
			found("finished", "s", 1, { done: true }),
		],
		new Map([
			["/agents/parent.jsonl", parent],
			["/agents/blocked.jsonl", blocked],
			["/agents/nested.jsonl", createFacts()],
		]),
	);
	assert.deepEqual(
		settled.map(({ subagent }) => [subagent.id, subagent.live, subagent.done]),
		[
			["parent", false, false],
			["nested", false, true],
			["blocked", true, false],
			["finished", false, true],
		],
	);
});
