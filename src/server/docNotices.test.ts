import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createDocNotices,
	maxNoticesPerSession,
	noticeTtlMs,
} from "./docNotices.ts";

describe("doc notices", () => {
	it("hands each session its notices once, newest last, without repeats", () => {
		const notices = createDocNotices(() => 0);
		notices.post("a", "one");
		notices.post("a", "two");
		notices.post("a", "one");
		notices.post("b", "other");
		assert.deepEqual(notices.take("a"), ["two", "one"]);
		assert.deepEqual(notices.take("a"), []);
		assert.deepEqual(notices.take("b"), ["other"]);
	});

	it("keeps the latest few and drops stale ones", () => {
		let now = 0;
		const notices = createDocNotices(() => now);
		for (let i = 0; i < maxNoticesPerSession + 5; i++) {
			notices.post("a", `n${i}`);
		}
		const kept = notices.take("a");
		assert.equal(kept.length, maxNoticesPerSession);
		assert.equal(kept[0], "n5");
		notices.post("a", "old");
		now = noticeTtlMs;
		assert.deepEqual(notices.take("a"), []);
	});
});
