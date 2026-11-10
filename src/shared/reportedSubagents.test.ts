import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseReportedSubagents,
	reportedSubagent,
} from "./reportedSubagents.ts";

const sub = (
	id: string,
	state: "working" | "idle" | "done",
	updatedAt: number,
	parent?: string,
) => ({
	id,
	description: `do ${id}`,
	type: "general-purpose",
	state,
	updatedAt,
	...(parent ? { parent } : {}),
});

test("a card's subagents parse, and a bad one refuses the list", () => {
	assert.deepEqual(parseReportedSubagents([sub("a", "done", 1)]), [
		sub("a", "done", 1),
	]);
	assert.equal(
		parseReportedSubagents([{ ...sub("a", "done", 1), state: "lost" }]),
		null,
	);
	assert.equal(
		parseReportedSubagents([{ ...sub("a", "done", 1), id: "../x" }]),
		null,
	);
	assert.equal(parseReportedSubagents("nope"), null);
	assert.equal(
		parseReportedSubagents(
			Array.from({ length: 41 }, (_, i) => sub(`s${i}`, "done", i)),
		),
		null,
	);
});

test("a reported subagent becomes the board's own under its owner", () => {
	assert.deepEqual(
		reportedSubagent(sub("child", "working", 5, "top"), "self-fix-1"),
		{
			id: "child",
			kind: "agent",
			sessionId: "self-fix-1",
			parentAgentId: "top",
			type: "general-purpose",
			description: "do child",
			live: true,
			done: false,
			startedAt: 5,
			updatedAt: 5,
		},
	);
	const done = reportedSubagent(sub("a", "done", 2), "s");
	assert.equal(done.live, false);
	assert.equal(done.done, true);
	assert.equal(reportedSubagent(sub("b", "idle", 3), "s").live, false);
	assert.equal(
		reportedSubagent(sub("c", "working", 3), "s", false).live,
		false,
	);
});
