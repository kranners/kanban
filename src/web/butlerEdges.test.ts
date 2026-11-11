import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ButlerCard,
	ButlerEdgeSummary,
	Session,
} from "../shared/types.ts";
import {
	chipLabel,
	chipSpot,
	drawnEdges,
	edgeCurve,
	isRelayedPair,
	pillLabel,
} from "./butlerEdges.ts";

const card = (thread: string, x: number): ButlerCard => ({
	id: `thread-${thread}`,
	kind: "butler-card",
	title: `Thread ${thread}`,
	state: "working",
	x,
	y: 0,
	w: 300,
	h: 200,
	z: 1,
	updatedAt: 0,
	thread: {
		id: thread,
		kind: "desk",
		link: `https://discord.com/channels/1/${thread}`,
		private: false,
	},
});

const cards = [card("11111", 0), card("22222", 600)];

const sessions = [
	{ id: "session_abc", short: null, name: "cloud abc" },
	{ id: "local-1", short: "ab12cd34", name: "local" },
	...cards.map((c) => ({ id: c.id, short: null, name: c.title })),
] as Session[];

const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {
	session_abc: { x: 0, y: 600, w: 300, h: 200 },
	"local-1": { x: 600, y: 600, w: 300, h: 200 },
	...Object.fromEntries(cards.map((c) => [c.id, c])),
};
const box = (id: string) => boxes[id];

const thread = (id: string) => ({ kind: "thread", id }) as const;
const sessionEnd = (id: string) => ({ kind: "session", id }) as const;

const edge = (
	from: ButlerEdgeSummary["from"],
	to: ButlerEdgeSummary["to"],
	fields: Partial<ButlerEdgeSummary> = {},
): ButlerEdgeSummary => ({
	from,
	to,
	via: "prompt",
	count: 1,
	lastAt: 100,
	...fields,
});

test("links threads and sessions on the board, merging the ways one pair went", () => {
	const { lines, chips } = drawnEdges(
		[
			edge(thread("11111"), thread("22222"), { via: "desk say", count: 2 }),
			edge(thread("11111"), sessionEnd("session_abc"), { lastAt: 50 }),
			edge(thread("11111"), sessionEnd("session_abc"), {
				via: "start",
				lastAt: 90,
			}),
			edge(thread("22222"), sessionEnd("ab12cd34")),
		],
		sessions,
		box,
		undefined,
	);
	assert.deepEqual(
		lines.map((l) => [l.title, l.count, l.lastAt, l.vias]),
		[
			["Thread 11111 → Thread 22222", 2, 100, ["desk say"]],
			["Thread 11111 → cloud abc", 2, 90, ["prompt", "start"]],
			["Thread 22222 → local", 1, 100, ["prompt"]],
		],
	);
	assert.deepEqual(chips, []);
});

test("an end that is not on the board draws nothing, and the DM becomes a chip", () => {
	const { lines, chips } = drawnEdges(
		[
			edge(thread("99999"), thread("11111")),
			edge(thread("33333"), thread("11111"), { count: 4 }),
			edge(thread("22222"), thread("33333")),
			edge(thread("33333"), sessionEnd("gone")),
		],
		sessions,
		box,
		"33333",
	);
	assert.deepEqual(lines, []);
	assert.deepEqual(
		chips.map((c) => [c.title, c.fromDm, c.count, c.index]),
		[
			["DM → Thread 11111", true, 4, 0],
			["Thread 22222 → DM", false, 1, 0],
		],
	);
	assert.equal(
		chipLabel(chips[0] as never, 100 + 5 * 60_000),
		"✉ 4 from DM · 5m",
	);
	assert.equal(chipLabel(chips[1] as never, 100), "✉ 1 to DM · now");
	assert.deepEqual(chipSpot({ box: cards[0] as ButlerCard, index: 1 }), {
		x: 300,
		y: -30,
	});
});

test("a pill says how many and when", () => {
	assert.equal(pillLabel(3, 0, 3 * 60_000), "3 · 3m ago");
	assert.equal(pillLabel(1, 0, 1000), "1 · just now");
});

test("a curve runs edge to edge, bends, and is skipped for overlapping boxes", () => {
	const curve = edgeCurve(
		{ x: 0, y: 0, w: 100, h: 100 },
		{ x: 400, y: 0, w: 100, h: 100 },
	);
	assert.ok(curve);
	assert.match(curve.path, /^M100 [0-9.]+ Q250 [0-9.]+ 400 [0-9.]+$/);
	assert.ok(curve.mid.y > 50, "it bends away from the arcs' side");
	assert.equal(
		edgeCurve({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }),
		null,
	);
});

test("a prompt or cloud message pair is drawn like Butler's", () => {
	assert.equal(isRelayedPair([{ kind: "cloud" }]), true);
	assert.equal(isRelayedPair([{}, { kind: "send" }]), false);
});
