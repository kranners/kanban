import assert from "node:assert/strict";
import { test } from "node:test";
import type { Annotations, Board, ButlerCard } from "../shared/types.ts";
import { cardOf, withButlerSubagents } from "./butlerSubagents.ts";
import { withSubagentsShown } from "./subagentSetting.ts";

const board = (parts: Partial<Board> = {}): Board => ({
	sessions: [],
	subagents: [],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
	links: [],
	messages: [],
	generatedAt: 0,
	...parts,
});

const card = (id: string, fields: Partial<ButlerCard> = {}): ButlerCard => ({
	id,
	kind: "butler-card",
	title: id,
	state: "working",
	x: 0,
	y: 0,
	w: 312,
	h: 216,
	z: 1,
	updatedAt: 0,
	...fields,
});

const reported = (
	id: string,
	state: "working" | "idle" | "done",
	parent?: string,
) => ({
	id,
	description: `do ${id}`,
	type: "general-purpose",
	state,
	updatedAt: 5,
	...(parent ? { parent } : {}),
});

const cards: Annotations = {
	"self-fix-1": card("self-fix-1", {
		subagents: [
			reported("top", "working"),
			reported("child", "done", "top"),
			reported("lost", "idle", "gone"),
		],
	}),
	"thread-9": card("thread-9", { subagents: [reported("w", "working")] }),
};

test("a Butler card's subagents become the board's own, owned by the card", () => {
	const merged = withButlerSubagents(board(), cards);
	const byId = new Map(merged.subagents.map((s) => [s.id, s]));
	assert.equal(byId.get("top")?.sessionId, "self-fix-1");
	assert.equal(byId.get("top")?.live, true);
	assert.equal(byId.get("child")?.parentAgentId, "top");
	assert.equal(byId.get("child")?.done, true);
	assert.equal(
		byId.get("lost")?.parentAgentId,
		null,
		"a parent the card no longer reports leaves it under the card",
	);
	assert.deepEqual(merged.subagentCounts["self-fix-1"], {
		working: 1,
		idle: 1,
		done: 1,
	});
	assert.equal(merged.subagentStates.w, "working");
	assert.deepEqual(merged.links.find((l) => l.to.id === "child")?.from, {
		kind: "subagent",
		id: "top",
	});
	assert.deepEqual(merged.links.find((l) => l.to.id === "top")?.from, {
		kind: "session",
		id: "self-fix-1",
	});
	assert.equal(
		cardOf(byId.get("w") ?? { sessionId: "" }, cards)?.id,
		"thread-9",
	);
});

test("one Show subagents setting hides a card's subagents with a session's", () => {
	const hidden = withSubagentsShown(withButlerSubagents(board(), cards), false);
	assert.equal(hidden.subagents.length, 0);
	assert.equal(hidden.links.length, 0);
	assert.deepEqual(hidden.subagentCounts, {});
});

test("a subagent the board already has is never drawn twice", () => {
	const own = withButlerSubagents(
		board({
			subagents: [
				{
					id: "w",
					kind: "agent",
					sessionId: "real",
					parentAgentId: null,
					type: "t",
					description: "d",
					live: true,
					done: false,
					startedAt: 1,
					updatedAt: 1,
				},
			],
		}),
		cards,
	);
	assert.equal(own.subagents.filter((s) => s.id === "w").length, 1);
	assert.equal(own.subagents.find((s) => s.id === "w")?.sessionId, "real");
	assert.equal(withButlerSubagents(board(), {}).subagents.length, 0);
});
