import assert from "node:assert/strict";
import { test } from "node:test";
import type { Activity, Board, Session } from "../shared/types.ts";
import type { Group } from "./groups.ts";
import type { PlacedNode } from "./layout.ts";
import {
	activityCounts,
	byAttention,
	sessionsOnly,
	summariesOf,
} from "./summaries.ts";

function session(id: string, activity: Activity, updatedAt = 1): Session {
	return {
		id,
		short: id,
		pid: null,
		name: id,
		cwd: "/Users/me/dev/acme-api",
		project: "acme-api",
		kind: "background",
		activity,
		doing: null,
		needs: null,
		goal: null,
		startedAt: 1,
		updatedAt,
		attachable: true,
		cmux: false,
		artifacts: [],
		tasks: [],
		steps: [],
	};
}

function node(id: string, x: number): PlacedNode {
	return {
		key: `session:${id}`,
		ref: { kind: "session", id },
		family: 0,
		x,
		y: 0,
		w: 312,
		h: 240,
	};
}

test("sessions that need you come first, then by state and recency", () => {
	const sorted = byAttention([
		session("done", "done", 9),
		session("old", "working", 1),
		session("new", "working", 5),
		session("ask", "needs-you", 0),
	]);
	assert.deepEqual(
		sorted.map((s) => s.id),
		["ask", "new", "old", "done"],
	);
});

test("counts list only the states present, in attention order", () => {
	assert.deepEqual(
		activityCounts([
			session("a", "done"),
			session("b", "working"),
			session("c", "working"),
		]),
		[
			["working", 2],
			["done", 1],
		],
	);
});

test("a group gets one summary and a lone card gets its own", () => {
	const sessions = [
		session("a", "working"),
		session("b", "needs-you"),
		session("c", "idle"),
	];
	const nodes = new Map(
		[node("a", 0), node("b", 400), node("c", 4000)].map((n) => [n.key, n]),
	);
	const group: Group = {
		key: "session:a",
		project: "acme-api",
		cwd: "/Users/me/dev/acme-api",
		members: ["session:a", "session:b"],
		frame: { x: -24, y: -32, w: 760, h: 296 },
	};
	const summaries = summariesOf([group], sessions, nodes);
	assert.deepEqual(
		summaries.map((s) => [s.key, s.framed, s.sessions.map((x) => x.id)]),
		[
			["session:a", true, ["b", "a"]],
			["session:c", false, ["c"]],
		],
	);
	assert.deepEqual(summaries[1]?.frame, { x: 4000, y: 0, w: 312, h: 240 });
});

test("a group whose sessions have all left gets no summary", () => {
	const group: Group = {
		key: "region:r",
		project: "acme-web",
		cwd: "/Users/me/dev/acme-web",
		members: ["session:gone"],
		frame: { x: 0, y: 0, w: 400, h: 300 },
	};
	assert.deepEqual(summariesOf([group], [], new Map()), []);
});

test("far out, edges keep only links between sessions", () => {
	const board: Board = {
		sessions: [],
		subagents: [],
		subagentCounts: {},
		subagentStates: {},
		workflowRuns: {},
		workflows: [],
		links: [
			{
				from: { kind: "session", id: "a" },
				to: { kind: "session", id: "b" },
				kind: "spawned",
			},
			{
				from: { kind: "session", id: "a" },
				to: { kind: "subagent", id: "x" },
				kind: "subagent",
			},
		],
		messages: [
			{
				id: "m",
				from: { kind: "subagent", id: "x" },
				to: { kind: "session", id: "a" },
				at: 1,
				summary: "done",
			},
		],
		generatedAt: 1,
	};
	const shown = sessionsOnly(board);
	assert.deepEqual(
		shown.links.map((l) => l.kind),
		["spawned"],
	);
	assert.equal(shown.messages.length, 0);
});
