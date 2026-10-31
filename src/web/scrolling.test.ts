import assert from "node:assert/strict";
import { test } from "node:test";
import {
	boardRoute,
	latchMs,
	nextLatch,
	overflowsAlong,
	type ScrollBox,
	splitWheel,
	type WheelRoute,
} from "./scrolling.ts";

const box = (overrides: Partial<ScrollBox>): ScrollBox => ({
	scrollHeight: 300,
	scrollWidth: 100,
	clientHeight: 100,
	clientWidth: 100,
	overflowX: "hidden",
	overflowY: "auto",
	...overrides,
});

test("a box takes the wheel along an axis it overflows on, even at its edge", () => {
	assert.equal(overflowsAlong(box({}), "y"), true);
	assert.equal(overflowsAlong(box({ scrollHeight: 100 }), "y"), false);
	assert.equal(overflowsAlong(box({ overflowY: "hidden" }), "y"), false);
	assert.equal(overflowsAlong(box({ scrollWidth: 400 }), "x"), false);
	assert.equal(
		overflowsAlong(box({ scrollWidth: 400, overflowX: "auto" }), "x"),
		true,
	);
});

test("a gesture keeps the route it started with until the wheel pauses", () => {
	const note: WheelRoute<string> = { x: null, y: "note" };
	const start = nextLatch<string>(null, 0, () => boardRoute);
	assert.deepEqual(start, { route: boardRoute, until: latchMs });
	const during = nextLatch(start, latchMs - 1, () => note);
	assert.equal(during.route, boardRoute);
	assert.equal(during.until, 2 * latchMs - 1);
	assert.equal(nextLatch(during, 2 * latchMs, () => note).route, note);
});

test("a region takes only the axes it scrolls and the board pans the rest", () => {
	const split = splitWheel({ x: null, y: "note" }, 12, -30);
	assert.deepEqual(split.board, { dx: 12, dy: 0 });
	assert.deepEqual(split.scroll, { x: null, dx: 0, y: "note", dy: -30 });
});

test("a region that scrolls both ways takes the whole wheel", () => {
	const split = splitWheel({ x: "timeline", y: "card" }, 5, 9);
	assert.deepEqual(split.board, { dx: 0, dy: 0 });
	assert.deepEqual(split.scroll, { x: "timeline", dx: 5, y: "card", dy: 9 });
});

test("the board takes the whole wheel when no region scrolls", () => {
	const split = splitWheel(boardRoute, 5, 9);
	assert.deepEqual(split.board, { dx: 5, dy: 9 });
});
