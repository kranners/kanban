import assert from "node:assert/strict";
import { test } from "node:test";
import type { Activity, Board, Session, Subagent } from "../shared/types.ts";
import {
	activitiesOf,
	arrivals,
	countNeedingYou,
	isNextNeedingYouKey,
	needingYou,
	nextInLine,
	readingOrder,
} from "./attention.ts";

function session(id: string, activity: Activity): Session {
	return {
		id,
		short: null,
		pid: null,
		name: id,
		cwd: `/work/${id}`,
		project: id,
		kind: "background",
		activity,
		doing: null,
		needs: null,
		startedAt: 1,
		updatedAt: 1,
		attachable: true,
		cmux: false,
	};
}

function subagent(id: string, live: boolean, done: boolean): Subagent {
	return {
		id,
		sessionId: "acme-api",
		parentAgentId: null,
		type: "general-purpose",
		description: id,
		live,
		done,
		startedAt: 1,
		updatedAt: 1,
	};
}

function boardOf(sessions: Session[], subagents: Subagent[] = []): Board {
	return {
		sessions,
		subagents,
		subagentCounts: {},
		links: [],
		messages: [],
		generatedAt: 1,
	};
}

test("sessions keep their activity and subagents fold into working, idle or done", () => {
	const activities = activitiesOf(
		boardOf(
			[session("acme-api", "needs-you")],
			[
				subagent("a", true, false),
				subagent("b", false, false),
				subagent("c", false, true),
			],
		),
	);
	assert.deepEqual(
		[...activities],
		[
			["session:acme-api", "needs-you"],
			["subagent:a", "working"],
			["subagent:b", "idle"],
			["subagent:c", "done"],
		],
	);
});

test("an arrival is a known node moving into done or failed", () => {
	const previous = new Map<string, Activity>([
		["session:a", "working"],
		["session:b", "working"],
		["session:c", "done"],
		["session:d", "working"],
	]);
	const current = new Map<string, Activity>([
		["session:a", "done"],
		["session:b", "failed"],
		["session:c", "done"],
		["session:d", "idle"],
		["session:e", "done"],
	]);
	assert.deepEqual(
		[...arrivals(previous, current)],
		[
			["session:a", "done"],
			["session:b", "failed"],
		],
	);
});

test("nothing arrives when the activity is unchanged or the node is new", () => {
	const same = new Map<string, Activity>([["session:a", "done"]]);
	assert.equal(arrivals(same, same).size, 0);
	assert.equal(arrivals(new Map(), same).size, 0);
});

test("needing you counts only members waiting on a person", () => {
	const needing = needingYou(
		new Map<string, Activity>([
			["session:a", "needs-you"],
			["session:b", "idle"],
			["session:c", "needs-you"],
		]),
	);
	assert.deepEqual([...needing], ["session:a", "session:c"]);
	assert.equal(countNeedingYou(["session:a", "session:b"], needing), 1);
	assert.equal(countNeedingYou([], needing), 0);
});

test("cards are visited top to bottom, then left to right", () => {
	const order = readingOrder([
		{ key: "c", x: 0, y: 400 },
		{ key: "b", x: 500, y: 0 },
		{ key: "a", x: 0, y: 0 },
	]);
	assert.deepEqual(
		order.map((n) => n.key),
		["a", "b", "c"],
	);
});

test("the next card follows the last one visited and wraps around", () => {
	const keys = ["a", "b", "c"];
	assert.equal(nextInLine(keys, null), "a");
	assert.equal(nextInLine(keys, "a"), "b");
	assert.equal(nextInLine(keys, "c"), "a");
	assert.equal(nextInLine(keys, "gone"), "a");
	assert.equal(nextInLine([], "a"), undefined);
});

test("J visits the next card that needs you unless typing or chorded", () => {
	const press = {
		key: "j",
		repeat: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
	};
	assert.equal(isNextNeedingYouKey(press, false), true);
	assert.equal(isNextNeedingYouKey({ ...press, repeat: true }, false), true);
	assert.equal(isNextNeedingYouKey(press, true), false);
	assert.equal(isNextNeedingYouKey({ ...press, metaKey: true }, false), false);
	assert.equal(isNextNeedingYouKey({ ...press, key: "k" }, false), false);
});
