import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	Board,
	Layout,
	NodeRef,
	Point,
	Session,
	Subagent,
} from "../shared/types.ts";
import { gridSize } from "./grid.ts";
import type { NodeKey, PlacedNode } from "./layout.ts";
import {
	arrange,
	near,
	nearestFree,
	seedsOf,
	sessionSize,
	subagentSize,
} from "./placement.ts";

const stage = { width: 1600, height: 900 };

function session(id: string, startedAt: number): Session {
	return {
		id,
		short: id,
		pid: null,
		name: id,
		cwd: `/Users/me/dev/${id}`,
		project: id,
		kind: "background",
		activity: "idle",
		doing: null,
		needs: null,
		startedAt,
		updatedAt: startedAt,
		attachable: true,
	};
}

function subagent(id: string, sessionId: string, at = 1): Subagent {
	return {
		id,
		sessionId,
		parentAgentId: null,
		type: "explore",
		description: id,
		live: true,
		startedAt: at,
		updatedAt: at,
	};
}

const s = (id: string): NodeRef => ({ kind: "session", id });

function board(parts: Partial<Board>): Board {
	return {
		sessions: [],
		subagents: [],
		links: [],
		messages: [],
		generatedAt: 0,
		...parts,
	};
}

function place(
	b: Board,
	saved: Layout = {},
	remembered: ReadonlyMap<NodeKey, Point> = new Map(),
) {
	return arrange(b, saved, seedsOf(b, stage), remembered);
}

function assertApart(nodes: Iterable<PlacedNode>) {
	const list = [...nodes];
	for (const p of list) {
		for (const q of list) {
			if (p !== q) assert.ok(!near(p, q, 0), `${p.key} overlaps ${q.key}`);
		}
	}
}

function onGrid(node: PlacedNode) {
	return node.x % gridSize === 0 && node.y % gridSize === 0;
}

test("a fresh board is laid out on the grid without overlaps and every session is auto placed", () => {
	const b = board({
		sessions: [session("a", 1), session("b", 2), session("c", 3)],
		subagents: [subagent("x", "a"), subagent("y", "a", 2)],
	});
	const { nodes, auto } = place(b);
	assert.equal(nodes.size, 5);
	assertApart(nodes.values());
	assert.ok([...nodes.values()].every(onGrid));
	assert.deepEqual([...auto.keys()].sort(), [
		"session:a",
		"session:b",
		"session:c",
	]);
});

test("a saved placement is used as is, including its size", () => {
	const b = board({ sessions: [session("a", 1)] });
	const { nodes, auto } = place(b, {
		"session:a": { x: 480, y: -96, w: 600, h: 480 },
	});
	const a = nodes.get("session:a");
	assert.deepEqual([a?.x, a?.y, a?.w, a?.h], [480, -96, 600, 480]);
	assert.equal(auto.size, 0);
});

test("a new session lands in free space and placed sessions stay put", () => {
	const b = board({ sessions: [session("old", 1), session("new", 2)] });
	const saved: Layout = { "session:old": { x: 0, y: 0 } };
	const { nodes } = place(b, saved);
	const old = nodes.get("session:old");
	assert.deepEqual([old?.x, old?.y], [0, 0]);
	assertApart(nodes.values());
	const fresh = nodes.get("session:new");
	assert.ok(fresh && onGrid(fresh));
	assert.ok(!near(fresh, old as PlacedNode, gridSize - 1));
});

test("an auto placed session keeps its spot when other sessions appear", () => {
	const first = board({ sessions: [session("a", 1)] });
	const before = place(first);
	const remembered = new Map(before.auto);
	const second = board({
		sessions: [session("a", 1), session("b", 9), session("c", 10)],
	});
	const after = place(second, {}, remembered);
	assert.deepEqual(after.auto.get("session:a"), before.auto.get("session:a"));
	assertApart(after.nodes.values());
});

test("a remembered spot that is now taken by a saved card is given up", () => {
	const b = board({ sessions: [session("a", 1), session("b", 2)] });
	const remembered = new Map([["session:b", { x: 0, y: 0 }]]);
	const { nodes } = place(b, { "session:a": { x: 0, y: 0 } }, remembered);
	assertApart(nodes.values());
	assert.notDeepEqual(
		[nodes.get("session:b")?.x, nodes.get("session:b")?.y],
		[0, 0],
	);
});

test("subagents follow their session unless they have their own placement", () => {
	const b = board({
		sessions: [session("a", 1)],
		subagents: [subagent("x", "a"), subagent("y", "a", 2)],
	});
	const here = place(b, { "session:a": { x: 0, y: 0 } });
	const there = place(b, {
		"session:a": { x: 960, y: 480 },
		"subagent:y": { x: -240, y: -240 },
	});
	const hx = here.nodes.get("subagent:x");
	const tx = there.nodes.get("subagent:x");
	assert.equal(hx?.follows, "session:a");
	assert.deepEqual([tx?.x, tx?.y], [(hx?.x ?? 0) + 960, (hx?.y ?? 0) + 480]);
	assert.ok((hx?.y ?? 0) >= sessionSize.h);
	const ty = there.nodes.get("subagent:y");
	assert.deepEqual([ty?.x, ty?.y, ty?.w], [-240, -240, subagentSize.w]);
	assert.equal(ty?.follows, undefined);
});

test("followers move down when their session grows", () => {
	const b = board({
		sessions: [session("a", 1)],
		subagents: [subagent("x", "a")],
	});
	const small = place(b, { "session:a": { x: 0, y: 0 } });
	const tall = place(b, { "session:a": { x: 0, y: 0, w: 312, h: 480 } });
	assert.equal(
		(tall.nodes.get("subagent:x")?.y ?? 0) -
			(small.nodes.get("subagent:x")?.y ?? 0),
		480 - sessionSize.h,
	);
});

test("a spawned session lands near its parent", () => {
	const b = board({
		sessions: [session("parent", 1), session("child", 2), session("far", 0)],
		links: [{ from: s("parent"), to: s("child"), kind: "spawned" }],
	});
	const saved: Layout = {
		"session:parent": { x: 2400, y: 2400 },
		"session:far": { x: 0, y: 0 },
	};
	const { nodes } = place(b, saved);
	const child = nodes.get("session:child");
	assert.ok(child);
	assert.ok(Math.hypot(child.x - 2400, child.y - 2400) < 600);
	assertApart(nodes.values());
});

test("the nearest free spot is searched outward on the grid", () => {
	const clearOfWall = (at: Point) => at.x >= 3 * gridSize;
	assert.deepEqual(nearestFree({ x: 0, y: 0 }, clearOfWall), {
		x: 3 * gridSize,
		y: 0,
	});
	assert.equal(
		nearestFree({ x: 0, y: 0 }, () => false),
		null,
	);
});
