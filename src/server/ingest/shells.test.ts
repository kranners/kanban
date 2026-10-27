import assert from "node:assert/strict";
import { test } from "node:test";
import { createFacts } from "./records.ts";
import { shellsOf } from "./shells.ts";
import { subagentWindowMs } from "./subagents.ts";

const now = 10 * subagentWindowMs;

function owner(endedAt: number | null) {
	const facts = createFacts();
	facts.shells.set("brunning", {
		tool: "Bash",
		description: "Start the dev server",
		startedAt: 1,
		endedAt: null,
	});
	facts.shells.set("brecent", {
		tool: "Monitor",
		description: "Watch the crawl",
		startedAt: 1,
		endedAt: now - 1000,
	});
	facts.shells.set("bstale", {
		tool: "Bash",
		description: "Old build",
		startedAt: 1,
		endedAt: now - subagentWindowMs - 1,
	});
	return { sessionId: "s", parentAgentId: "agent", facts, endedAt };
}

test("a shell runs until it ends, and a long-finished one drops off", () => {
	assert.deepEqual(shellsOf(owner(null), now), [
		{
			id: "brunning",
			kind: "shell",
			sessionId: "s",
			parentAgentId: "agent",
			type: "shell",
			description: "Start the dev server",
			live: true,
			done: false,
			startedAt: 1,
			updatedAt: 1,
		},
		{
			id: "brecent",
			kind: "shell",
			sessionId: "s",
			parentAgentId: "agent",
			type: "monitor",
			description: "Watch the crawl",
			live: false,
			done: true,
			startedAt: 1,
			updatedAt: now - 1000,
		},
	]);
});

test("a shell ends with the agent or session that owns it", () => {
	const shells = shellsOf(owner(now - 5000), now);
	const running = shells.find(({ id }) => id === "brunning");
	assert.deepEqual(
		[running?.live, running?.done, running?.updatedAt],
		[false, true, now - 5000],
	);
});
