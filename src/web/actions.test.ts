import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, Session } from "../shared/types.ts";
import {
	cwdChoices,
	cycle,
	freeSpotNear,
	isQuickPromptKey,
	withoutSessions,
} from "./actions.ts";
import { gridSize } from "./grid.ts";
import { sessionSize } from "./placement.ts";

const plain = {
	key: "a",
	repeat: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
};

test("A opens the quick prompt only when unmodified and not typing", () => {
	assert.equal(isQuickPromptKey(plain, false), true);
	assert.equal(isQuickPromptKey({ ...plain, key: "A" }, false), true);
	assert.equal(isQuickPromptKey(plain, true), false);
	assert.equal(isQuickPromptKey({ ...plain, repeat: true }, false), false);
	for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"])
		assert.equal(
			isQuickPromptKey({ ...plain, [modifier]: true }, false),
			false,
		);
	assert.equal(isQuickPromptKey({ ...plain, key: "b" }, false), false);
});

test("cwd choices put the preferred one first without duplicates", () => {
	assert.deepEqual(cwdChoices("/b", ["/a", "/b", "/c"]), ["/b", "/a", "/c"]);
	assert.deepEqual(cwdChoices(null, ["/a", "/b"]), ["/a", "/b"]);
	assert.deepEqual(cwdChoices("/z", []), ["/z"]);
});

test("cycle wraps both ways and starts from the front for unknown values", () => {
	assert.equal(cycle(["/a", "/b", "/c"], "/c", 1), "/a");
	assert.equal(cycle(["/a", "/b", "/c"], "/a", -1), "/c");
	assert.equal(cycle(["/a", "/b"], "/x", 1), "/b");
	assert.equal(cycle([], "/a", 1), undefined);
});

test("a free spot snaps to the grid and steps clear of cards", () => {
	assert.deepEqual(freeSpotNear({ x: 30, y: 13 }, []), { x: 24, y: 24 });
	const card = { x: 0, y: 0, ...sessionSize };
	const spot = freeSpotNear({ x: 10, y: 10 }, [card]);
	assert.equal(Math.abs(spot.x % gridSize), 0);
	assert.equal(Math.abs(spot.y % gridSize), 0);
	const clear =
		spot.x >= card.w + gridSize ||
		spot.y >= card.h + gridSize ||
		spot.x + sessionSize.w + gridSize <= 0 ||
		spot.y + sessionSize.h + gridSize <= 0;
	assert.ok(clear, `spot ${JSON.stringify(spot)} overlaps the card`);
});

function session(id: string): Session {
	return {
		id,
		short: id,
		pid: null,
		name: id,
		cwd: "/dev/p",
		project: "p",
		kind: "background",
		activity: "idle",
		doing: null,
		needs: null,
		goal: null,
		startedAt: 1,
		updatedAt: 1,
		attachable: true,
		cmux: false,
		artifacts: [],
	};
}

test("removing sessions drops their subagents, links and messages", () => {
	const board: Board = {
		sessions: [session("a"), session("b")],
		subagentCounts: {},
		subagentStates: {},
		workflowRuns: {},
		subagents: [
			{
				id: "x",
				sessionId: "a",
				parentAgentId: null,
				type: "Explore",
				description: "",
				live: true,
				done: false,
				startedAt: 1,
				updatedAt: 1,
			},
		],
		links: [
			{
				from: { kind: "session", id: "a" },
				to: { kind: "subagent", id: "x" },
				kind: "subagent",
			},
			{
				from: { kind: "session", id: "b" },
				to: { kind: "session", id: "b" },
				kind: "spawned",
			},
		],
		messages: [
			{
				id: "m",
				from: { kind: "subagent", id: "x" },
				to: { kind: "session", id: "b" },
				at: 1,
				summary: "",
			},
		],
		generatedAt: 1,
	};
	const left = withoutSessions(board, new Set(["a"]));
	assert.deepEqual(
		left.sessions.map((s) => s.id),
		["b"],
	);
	assert.equal(left.subagents.length, 0);
	assert.equal(left.links.length, 1);
	assert.equal(left.messages.length, 0);
	assert.equal(withoutSessions(board, new Set()), board);
});
