import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ButlerCard } from "../shared/types.ts";
import { butlerLanes } from "./butlerCards.ts";

const card: ButlerCard = {
	id: "b",
	kind: "butler-card",
	title: "Tidy the board",
	state: "working",
	status: "moving cards",
	x: 0,
	y: 0,
	w: 312,
	h: 216,
	z: 1,
	updatedAt: 5000,
};

describe("a Butler card's timeline", () => {
	it("draws the stretches he worked or waited, the last still running", () => {
		const [work, steps] = butlerLanes(
			{
				...card,
				state: "needs-you",
				status: "which project?",
				history: [
					{ at: 1000, state: "idle" },
					{ at: 2000, state: "working", status: "moving cards" },
					{ at: 4000, state: "needs-you", status: "which project?" },
				],
			},
			9000,
		);
		assert.deepEqual(work?.spans, [
			{
				start: 2000,
				end: 4000,
				kind: "done",
				title: "Working: moving cards",
			},
			{
				start: 4000,
				end: 9000,
				kind: "active",
				title: "Needs you: which project?",
			},
		]);
		assert.deepEqual(
			steps?.events.map((e) => e.text),
			["Idle", "Working: moving cards", "Needs you: which project?"],
		);
	});

	it("shows a card from before timelines at its last update", () => {
		const lanes = butlerLanes(
			{ ...card, state: "done", status: "tidied" },
			9000,
		);
		assert.equal(lanes.length, 1);
		assert.deepEqual(lanes[0]?.events, [{ at: 5000, text: "Done: tidied" }]);
	});
});
