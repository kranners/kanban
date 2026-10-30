import assert from "node:assert/strict";
import { test } from "node:test";
import { hasRoom, type ScrollBox } from "./scrolling.ts";

const box = (overrides: Partial<ScrollBox>): ScrollBox => ({
	scrollTop: 0,
	scrollLeft: 0,
	scrollHeight: 300,
	scrollWidth: 100,
	clientHeight: 100,
	clientWidth: 100,
	overflowX: "hidden",
	overflowY: "auto",
	...overrides,
});

test("a box takes the wheel while it can scroll that way", () => {
	assert.equal(hasRoom(box({}), 0, 10), true);
	assert.equal(hasRoom(box({ scrollTop: 100 }), 0, -10), true);
});

test("a box at its edge lets the wheel go to the board", () => {
	assert.equal(hasRoom(box({}), 0, -10), false);
	assert.equal(hasRoom(box({ scrollTop: 200 }), 0, 10), false);
	assert.equal(hasRoom(box({ scrollHeight: 100 }), 0, 10), false);
});

test("a box only scrolls along the axes it overflows on", () => {
	assert.equal(hasRoom(box({ scrollWidth: 400 }), 10, 0), false);
	assert.equal(
		hasRoom(box({ scrollWidth: 400, overflowX: "auto" }), 10, 0),
		true,
	);
	assert.equal(hasRoom(box({ overflowY: "hidden" }), 0, 10), false);
});
