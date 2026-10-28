import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../shared/types.ts";
import { gridSize } from "./grid.ts";
import type { Group } from "./groups.ts";
import { groupAt, groupsOf, topGroupAt } from "./groups.ts";
import type { PlacedNode } from "./layout.ts";

function session(
	id: string,
	project: string,
	cwd = `/dev/${project}`,
	updatedAt = 1,
): Session {
	return {
		id,
		short: id,
		pid: null,
		name: id,
		cwd,
		project,
		kind: "background",
		activity: "idle",
		doing: null,
		needs: null,
		goal: null,
		startedAt: 1,
		updatedAt,
		attachable: true,
		cmux: false,
		artifacts: [],
	};
}

function node(id: string, x: number, y: number, follows?: string): PlacedNode {
	const kind = follows ? "subagent" : "session";
	return {
		key: `${kind}:${id}`,
		ref: { kind, id },
		family: 0,
		x,
		y,
		w: follows ? 216 : 312,
		h: follows ? 72 : 240,
		...(follows ? { follows } : {}),
	};
}

function nodes(...list: PlacedNode[]) {
	return new Map(list.map((n) => [n.key, n]));
}

test("nearby sessions of one project form a group, others do not", () => {
	const sessions = [
		session("a", "api"),
		session("b", "api"),
		session("c", "web"),
		session("d", "api"),
	];
	const placed = nodes(
		node("a", 0, 0),
		node("b", 312 + gridSize, 0),
		node("c", 0, 240 + gridSize),
		node("d", 4000, 0),
	);
	const groups = groupsOf(sessions, placed);
	assert.equal(groups.length, 1);
	assert.deepEqual([...(groups[0]?.members ?? [])].sort(), [
		"session:a",
		"session:b",
	]);
	assert.equal(groups[0]?.project, "api");
});

test("grouping is transitive across a chain of neighbours", () => {
	const sessions = ["a", "b", "c"].map((id) => session(id, "api"));
	const placed = nodes(node("a", 0, 0), node("b", 360, 0), node("c", 720, 0));
	assert.equal(groupsOf(sessions, placed)[0]?.members.length, 3);
});

test("sessions further apart than the reach stay separate", () => {
	const sessions = [session("a", "api"), session("b", "api")];
	const placed = nodes(node("a", 0, 0), node("b", 312 + 5 * gridSize, 0));
	assert.equal(groupsOf(sessions, placed).length, 0);
});

test("the frame wraps members and their following subagents", () => {
	const sessions = [session("a", "api"), session("b", "api")];
	const placed = nodes(
		node("a", 0, 0),
		node("b", 336, 0),
		node("x", 0, 288, "session:a"),
	);
	const [group] = groupsOf(sessions, placed);
	assert.ok(group);
	assert.ok(group.frame.x < 0 && group.frame.y < 0);
	assert.ok(group.frame.x + group.frame.w > 336 + 312);
	assert.ok(group.frame.y + group.frame.h > 288 + 72);
});

test("a point inside a group's frame finds it and its most common cwd", () => {
	const sessions = [
		session("a", "api", "/dev/api/worktree", 9),
		session("b", "api", "/dev/api"),
		session("c", "api", "/dev/api"),
	];
	const placed = nodes(node("a", 0, 0), node("b", 336, 0), node("c", 672, 0));
	const groups = groupsOf(sessions, placed);
	const found = groupAt(groups, { x: 500, y: 100 });
	assert.equal(found?.cwd, "/dev/api");
	assert.equal(found?.project, "api");
	assert.equal(groupAt(groups, { x: 5000, y: 100 }), null);
});

function frame(key: string, x: number, region = false): Group {
	const rect = { x, y: 0, w: 400, h: 400 };
	const cwd = `/dev/${key}`;
	return {
		key,
		project: key,
		cwd,
		members: [],
		frame: rect,
		...(region ? { region: { id: key, cwd, name: null, ...rect } } : {}),
	};
}

test("the topmost frame under a point is the one painted last", () => {
	const groups = [
		frame("group", 0),
		frame("left", 100, true),
		frame("right", 200, true),
	];
	assert.equal(topGroupAt(groups, null, { x: 250, y: 10 })?.key, "right");
	assert.equal(topGroupAt(groups, null, { x: 50, y: 10 })?.key, "group");
	assert.equal(topGroupAt(groups, null, { x: 900, y: 10 }), null);
});

test("regions paint over plain groups whatever their order", () => {
	const groups = [frame("left", 100, true), frame("group", 0)];
	assert.equal(topGroupAt(groups, null, { x: 150, y: 10 })?.key, "left");
});

test("the frame brought forward wins wherever it covers the point", () => {
	const groups = [
		frame("group", 0),
		frame("left", 100, true),
		frame("right", 200, true),
	];
	assert.equal(topGroupAt(groups, "left", { x: 250, y: 10 })?.key, "left");
	assert.equal(topGroupAt(groups, "group", { x: 250, y: 10 })?.key, "group");
	assert.equal(topGroupAt(groups, "left", { x: 550, y: 10 })?.key, "right");
});
