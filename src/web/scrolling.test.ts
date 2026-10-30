import assert from "node:assert/strict";
import { test } from "node:test";
import {
	axisOf,
	latchMs,
	nextLatch,
	overflowsAlong,
	type ScrollBox,
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

test("the wheel's axis is the one it moves most along", () => {
	assert.equal(axisOf(3, -40), "y");
	assert.equal(axisOf(-30, 4), "x");
});

test("a gesture keeps the mode it started with until the wheel pauses", () => {
	const start = nextLatch(null, 0, () => "board");
	assert.deepEqual(start, { mode: "board", until: latchMs });
	const during = nextLatch(start, latchMs - 1, () => "scroll");
	assert.equal(during.mode, "board");
	assert.equal(during.until, 2 * latchMs - 1);
	assert.equal(nextLatch(during, 2 * latchMs, () => "scroll").mode, "scroll");
});
