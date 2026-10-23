import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeTime } from "./time.ts";

test("relative time picks the largest whole unit", () => {
	const now = 1_000_000_000;
	assert.equal(relativeTime(now - 1000, now), "now");
	assert.equal(relativeTime(now - 42_000, now), "42s");
	assert.equal(relativeTime(now - 5 * 60_000, now), "5m");
	assert.equal(relativeTime(now - 3 * 3_600_000 - 1, now), "3h");
	assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d");
	assert.equal(relativeTime(now + 9000, now), "now");
});
