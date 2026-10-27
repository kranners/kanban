import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	Board,
	Link,
	NodeRef,
	Session,
	Subagent,
} from "../shared/types.ts";
import {
	defaultLayoutOptions,
	familiesOf,
	layoutBoard,
	nodeKey,
} from "./layout.ts";

function session(
	id: string,
	startedAt: number,
	updatedAt = startedAt,
): Session {
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
		goal: null,
		startedAt,
		updatedAt,
		attachable: true,
		cmux: false,
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
		done: false,
		startedAt: at,
		updatedAt: at,
	};
}

const s = (id: string): NodeRef => ({ kind: "session", id });
const a = (id: string): NodeRef => ({ kind: "subagent", id });

function board(parts: Partial<Board>): Board {
	return {
		sessions: [],
		subagents: [],
		subagentCounts: {},
		links: [],
		messages: [],
		generatedAt: 0,
		...parts,
	};
}

test("links join families but messages do not", () => {
	const b = board({
		sessions: [session("acme-api", 1), session("acme-web", 2), session("x", 3)],
		links: [{ from: s("acme-api"), to: s("acme-web"), kind: "spawned" }],
		messages: [
			{ id: "m", from: s("x"), to: s("acme-api"), at: 4, summary: "" },
		],
	});
	const families = familiesOf(b).map((f) => [...f].sort());
	assert.deepEqual(families, [
		["session:x"],
		["session:acme-api", "session:acme-web"],
	]);
});

test("families are ordered newest first by when they started", () => {
	const b = board({
		sessions: [session("old", 1), session("new", 9), session("mid", 5)],
	});
	assert.deepEqual(familiesOf(b), [
		["session:new"],
		["session:mid"],
		["session:old"],
	]);
});

test("activity does not move families", () => {
	const quiet = board({
		sessions: [session("old", 1, 2), session("new", 9, 10)],
	});
	const busy = board({
		sessions: [session("old", 1, 99), session("new", 9, 10)],
	});
	assert.deepEqual(familiesOf(busy), familiesOf(quiet));
	assert.deepEqual(
		layoutBoard(busy).nodes.get("session:old"),
		layoutBoard(quiet).nodes.get("session:old"),
	);
});

test("a family is dated by its earliest node, so children keep it in place", () => {
	const b = board({
		sessions: [session("root", 1), session("child", 20), session("mid", 5)],
		links: [{ from: s("root"), to: s("child"), kind: "spawned" }],
	});
	assert.deepEqual(
		familiesOf(b).map((f) => [...f].sort()),
		[["session:mid"], ["session:child", "session:root"]],
	);
});

test("equal start times order by key", () => {
	const b = board({ sessions: [session("b", 1), session("a", 1)] });
	assert.deepEqual(familiesOf(b), [["session:a"], ["session:b"]]);
});

test("subagents join their session even without an explicit link", () => {
	const b = board({
		sessions: [session("acme-api", 1)],
		subagents: [subagent("sa1", "acme-api")],
	});
	assert.deepEqual(familiesOf(b).length, 1);
});

test("children sit below their parent and are centred under it", () => {
	const links: Link[] = [
		{ from: s("root"), to: a("one"), kind: "subagent" },
		{ from: s("root"), to: a("two"), kind: "subagent" },
	];
	const b = board({
		sessions: [session("root", 1)],
		subagents: [subagent("one", "root", 1), subagent("two", "root", 2)],
		links,
	});
	const { nodes } = layoutBoard(b);
	const root = nodes.get(nodeKey(s("root")));
	const one = nodes.get(nodeKey(a("one")));
	const two = nodes.get(nodeKey(a("two")));
	assert.ok(root && one && two);
	assert.equal(one.y, root.y + root.h + defaultLayoutOptions.levelGap);
	assert.equal(one.y, two.y);
	assert.ok(one.x + one.w <= two.x);
	const childrenCentre = (one.x + two.x + two.w) / 2;
	assert.equal(root.x + root.w / 2, childrenCentre);
	assert.equal(one.w, defaultLayoutOptions.subagent.w);
});

function crowd(count: number): Subagent[] {
	return Array.from({ length: count }, (_, i) =>
		subagent(`sa${i}`, "root", i + 1),
	);
}

function overlapping(
	placed: { key: string; x: number; y: number; w: number; h: number }[],
): string[] {
	return placed.flatMap((p) =>
		placed
			.filter(
				(q) =>
					p !== q &&
					p.x < q.x + q.w &&
					q.x < p.x + p.w &&
					p.y < q.y + q.h &&
					q.y < p.y + p.h,
			)
			.map((q) => `${p.key} overlaps ${q.key}`),
	);
}

test("many subagents wrap into a compact grid under their session", () => {
	const {
		subagent: size,
		subagentColumns,
		siblingGap,
		levelGap,
	} = defaultLayoutOptions;
	const b = board({ sessions: [session("root", 0)], subagents: crowd(40) });
	const { nodes, width } = layoutBoard(b);
	const root = nodes.get(nodeKey(s("root")));
	const grid = crowd(40).map((c) => nodes.get(nodeKey(a(c.id))));
	assert.ok(root);
	const gridWidth = subagentColumns * (size.w + siblingGap) - siblingGap;
	assert.equal(width, gridWidth);
	assert.equal(new Set(grid.map((n) => n?.x)).size, subagentColumns);
	assert.equal(
		Math.min(...grid.map((n) => n?.y ?? 0)),
		root.y + root.h + levelGap,
	);
	assert.equal(root.x + root.w / 2, width / 2);
	assert.deepEqual(overlapping([...nodes.values()]), []);
});

test("the grid reads oldest first, left to right then down", () => {
	const b = board({ sessions: [session("root", 0)], subagents: crowd(5) });
	const { nodes } = layoutBoard(b);
	const at = (id: string) => nodes.get(nodeKey(a(id)));
	const [oldest, second, third, fourth] = ["sa0", "sa1", "sa2", "sa3"].map(at);
	assert.ok(oldest && second && third && fourth);
	assert.equal(oldest.y, third.y);
	assert.ok(oldest.x < second.x && second.x < third.x);
	assert.equal(fourth.x, oldest.x);
	assert.ok(fourth.y > oldest.y);
});

test("a new subagent joins the end of a full grid without moving the others", () => {
	const before = layoutBoard(
		board({ sessions: [session("root", 0)], subagents: crowd(7) }),
	);
	const after = layoutBoard(
		board({ sessions: [session("root", 0)], subagents: crowd(8) }),
	);
	for (const c of crowd(7)) {
		const key = nodeKey(a(c.id));
		const was = before.nodes.get(key);
		const now = after.nodes.get(key);
		assert.deepEqual([now?.x, now?.y], [was?.x, was?.y], key);
	}
});

test("spawned sessions stay a tree beside the subagent grid", () => {
	const b = board({
		sessions: [session("root", 0), session("child", 50)],
		subagents: crowd(7),
		links: [{ from: s("root"), to: s("child"), kind: "spawned" }],
	});
	const { nodes } = layoutBoard(b);
	const root = nodes.get(nodeKey(s("root")));
	const child = nodes.get(nodeKey(s("child")));
	const grid = crowd(7).map((c) => nodes.get(nodeKey(a(c.id))));
	assert.ok(root && child);
	assert.equal(child.y, root.y + root.h + defaultLayoutOptions.levelGap);
	assert.ok(grid.every((n) => n && n.x + n.w <= child.x));
	assert.deepEqual(overlapping([...nodes.values()]), []);
});

test("a subagent with its own subagents keeps them in a tree below it", () => {
	const nested = { ...subagent("inner", "root", 9), parentAgentId: "outer" };
	const b = board({
		sessions: [session("root", 0)],
		subagents: [subagent("outer", "root", 1), nested, ...crowd(4)],
	});
	const { nodes } = layoutBoard(b);
	const outer = nodes.get(nodeKey(a("outer")));
	const inner = nodes.get(nodeKey(a("inner")));
	assert.ok(outer && inner);
	assert.equal(inner.y, outer.y + outer.h + defaultLayoutOptions.levelGap);
	assert.deepEqual(overlapping([...nodes.values()]), []);
});

test("families wrap into rows by max width without overlapping", () => {
	const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`, i));
	const { nodes, width } = layoutBoard(board({ sessions }), {
		...defaultLayoutOptions,
		maxWidth: 1000,
	});
	const placed = [...nodes.values()];
	assert.ok(width <= 1000);
	assert.ok(new Set(placed.map((n) => n.y)).size > 1);
	for (const p of placed) {
		for (const q of placed) {
			if (p === q) continue;
			const apart =
				p.x + p.w <= q.x ||
				q.x + q.w <= p.x ||
				p.y + p.h <= q.y ||
				q.y + q.h <= p.y;
			assert.ok(apart, `${p.key} overlaps ${q.key}`);
		}
	}
});

test("a link cycle still places every node once", () => {
	const b = board({
		sessions: [session("p", 1), session("q", 2)],
		links: [
			{ from: s("p"), to: s("q"), kind: "forked" },
			{ from: s("q"), to: s("p"), kind: "forked" },
		],
	});
	assert.equal(layoutBoard(b).nodes.size, 2);
});

test("links to unknown nodes are ignored", () => {
	const b = board({
		sessions: [session("p", 1)],
		links: [{ from: s("ghost"), to: s("p"), kind: "spawned" }],
	});
	const p = layoutBoard(b).nodes.get("session:p");
	assert.deepEqual([p?.x, p?.y], [0, 0]);
});
