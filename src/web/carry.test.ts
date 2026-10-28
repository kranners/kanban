import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, Note, Session, Subagent } from "../shared/types.ts";
import { carriedWith } from "./carry.ts";
import type { Group } from "./groups.ts";
import type { PlacedNode } from "./layout.ts";

function session(id: string): Session {
	return {
		id,
		short: id,
		pid: null,
		name: id,
		cwd: "/dev/acme-api",
		project: "acme-api",
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
		tasks: [],
		steps: [],
	};
}

function subagent(
	id: string,
	sessionId: string,
	parentAgentId: string | null = null,
): Subagent {
	return {
		id,
		kind: "agent",
		sessionId,
		parentAgentId,
		type: "general-purpose",
		description: id,
		live: false,
		done: true,
		startedAt: 1,
		updatedAt: 1,
	};
}

function placed(key: string, follows?: string): PlacedNode {
	const [kind, id] = key.split(":") as ["session" | "subagent", string];
	return {
		key,
		ref: { kind, id },
		family: 0,
		x: 0,
		y: 0,
		w: 10,
		h: 10,
		...(follows ? { follows } : {}),
	};
}

function note(id: string, sessionId?: string): Note {
	return {
		id,
		kind: "note",
		text: id,
		color: "yellow",
		x: 0,
		y: 0,
		w: 10,
		h: 10,
		z: 1,
		...(sessionId ? { session: sessionId } : {}),
	};
}

function project(key: string, members: string[]): Group {
	return {
		key,
		project: key,
		cwd: "/dev",
		members,
		frame: { x: 0, y: 0, w: 10, h: 10 },
	};
}

const board: Board = {
	sessions: ["a", "child", "elsewhere"].map(session),
	subagents: [
		subagent("pinned", "a"),
		subagent("follower", "a"),
		subagent("nested", "a", "pinned"),
	],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
	links: [
		{
			from: { kind: "session", id: "a" },
			to: { kind: "session", id: "child" },
			kind: "spawned",
		},
		{
			from: { kind: "subagent", id: "pinned" },
			to: { kind: "session", id: "elsewhere" },
			kind: "spawned",
		},
	],
	messages: [],
	generatedAt: 0,
};

const nodes = new Map(
	[
		placed("session:a"),
		placed("session:child"),
		placed("session:elsewhere"),
		placed("subagent:pinned"),
		placed("subagent:follower", "session:a"),
		placed("subagent:nested", "session:a"),
	].map((node) => [node.key, node]),
);

const notes = [
	note("tethered", "a"),
	note("child-note", "child"),
	note("loose"),
];

test("a card carries its pinned subagents, spawned sessions and tethered notes", () => {
	const carried = carriedWith(["session:a"], board, nodes, notes, []);
	assert.deepEqual(carried.nodes.sort(), [
		"session:child",
		"session:elsewhere",
		"subagent:pinned",
	]);
	assert.deepEqual(carried.notes.map((n) => n.id).sort(), [
		"child-note",
		"tethered",
	]);
});

test("a card never carries another project's cards", () => {
	const projects = [
		project("mine", ["session:a", "session:child"]),
		project("theirs", ["session:elsewhere"]),
	];
	const carried = carriedWith(["session:a"], board, nodes, notes, projects);
	assert.deepEqual(carried.nodes.sort(), ["session:child", "subagent:pinned"]);
});

test("a subagent carries the subagents it started, even ones following its session", () => {
	const carried = carriedWith(
		["subagent:pinned"],
		board,
		nodes,
		[],
		[project("theirs", ["session:elsewhere"])],
	);
	assert.deepEqual(carried.nodes, ["subagent:nested"]);
});

test("a card leaves what is not linked to it", () => {
	const carried = carriedWith(["session:child"], board, nodes, notes, []);
	assert.deepEqual(carried.nodes, []);
	assert.deepEqual(
		carried.notes.map((n) => n.id),
		["child-note"],
	);
});
