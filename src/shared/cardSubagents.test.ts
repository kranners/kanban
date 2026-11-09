import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cardSubagentSummary,
	orderCardSubagents,
	parseCardSubagents,
} from "./cardSubagents.ts";

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
	assert.deepEqual(parseCardSubagents([sub("a", "done", 1)]), [
		sub("a", "done", 1),
	]);
	assert.equal(
		parseCardSubagents([{ ...sub("a", "done", 1), state: "lost" }]),
		null,
	);
	assert.equal(
		parseCardSubagents([{ ...sub("a", "done", 1), id: "../x" }]),
		null,
	);
	assert.equal(parseCardSubagents("nope"), null);
	assert.equal(
		parseCardSubagents(
			Array.from({ length: 41 }, (_, i) => sub(`s${i}`, "done", i)),
		),
		null,
	);
});

test("the count reads as Aaron asked, states with none left out", () => {
	assert.equal(
		cardSubagentSummary([
			sub("a", "working", 3),
			sub("b", "done", 2),
			sub("c", "done", 1),
		]),
		"3 subagents: 1 working, 2 done",
	);
	assert.equal(
		cardSubagentSummary([sub("a", "idle", 1)]),
		"1 subagent: 1 idle",
	);
});

test("working ones come first and each parent is followed by its own", () => {
	const ordered = orderCardSubagents([
		sub("old-done", "done", 1),
		sub("child", "done", 5, "top"),
		sub("top", "working", 4),
		sub("grand", "working", 6, "child"),
	]).map(({ subagent, depth }) => `${subagent.id}:${depth}`);
	assert.deepEqual(ordered, ["top:0", "child:1", "grand:2", "old-done:0"]);
});
