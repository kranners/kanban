import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AskQuestion } from "../shared/conversation.ts";
import {
	answerQuestions,
	choosePermission,
	notShowing,
	validAnswers,
} from "./answer.ts";
import { fakeTui } from "./fakeTui.ts";

const timing = { pollMs: 1, settleMs: 40 };

const colour: AskQuestion = {
	question: "Pick a colour",
	header: "Colour",
	multiSelect: false,
	options: [
		{ label: "Red", description: "warm" },
		{ label: "Green", description: "natural" },
		{ label: "Blue", description: "cool" },
	],
};

const toppings: AskQuestion = {
	question: "Pick toppings",
	header: "Toppings",
	multiSelect: true,
	options: [
		{ label: "Cheese", description: "dairy" },
		{ label: "Olives", description: "brined" },
		{ label: "Basil", description: "herb" },
	],
};

const permissionOptions = [
	"Yes",
	"Yes, and always allow access to /tmp/demo from this project",
	"No",
];

describe("answering a permission prompt", () => {
	it("moves to the chosen option and confirms it", async () => {
		const tui = fakeTui({ permission: permissionOptions });
		const outcome = await choosePermission(tui, 2, "No", timing);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.equal(tui.chosen, "No");
	});

	it("keeps the default choice with a single Enter", async () => {
		const tui = fakeTui({ permission: permissionOptions });
		assert.equal((await choosePermission(tui, 0, "Yes", timing)).ok, true);
		assert.equal(tui.chosen, "Yes");
	});

	it("waits out a slow redraw before confirming", async () => {
		const tui = fakeTui({ permission: permissionOptions, lagReads: 3 });
		assert.equal(
			(await choosePermission(tui, 1, permissionOptions[1] ?? "", timing)).ok,
			true,
		);
		assert.equal(tui.chosen, permissionOptions[1]);
	});

	it("refuses when the prompt on screen is not the one chosen from", async () => {
		const tui = fakeTui({ permission: ["Yes", "No"] });
		const outcome = await choosePermission(
			tui,
			1,
			"Yes, and don't ask again",
			timing,
		);
		assert.deepEqual(outcome, { ok: false, error: notShowing });
		assert.equal(tui.chosen, null);
		const closed = fakeTui({});
		assert.equal((await choosePermission(closed, 0, "Yes", timing)).ok, false);
	});
});

describe("answering questions", () => {
	it("answers one single-select question", async () => {
		const tui = fakeTui({ questions: [colour] });
		const outcome = await answerQuestions(
			tui,
			[colour],
			[{ selected: ["Blue"], other: null }],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.submitted, { "Pick a colour": "Blue" });
	});

	it("types an Other answer into a single-select question", async () => {
		const tui = fakeTui({ questions: [colour] });
		const outcome = await answerQuestions(
			tui,
			[colour],
			[{ selected: [], other: "Teal" }],
			timing,
		);
		assert.equal(outcome.ok, true);
		assert.deepEqual(tui.sent, ["Teal"]);
		assert.deepEqual(tui.submitted, { "Pick a colour": "Teal" });
	});

	it("answers several questions, toggling multi-select rows, then submits the review", async () => {
		const tui = fakeTui({ questions: [colour, toppings] });
		const outcome = await answerQuestions(
			tui,
			[colour, toppings],
			[
				{ selected: ["Green"], other: null },
				{ selected: ["Cheese", "Basil"], other: "Anchovies" },
			],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.submitted, {
			"Pick a colour": "Green",
			"Pick toppings": "Cheese, Basil, Anchovies",
		});
	});

	it("refuses when the screen shows a different question", async () => {
		const tui = fakeTui({ questions: [toppings] });
		const outcome = await answerQuestions(
			tui,
			[colour],
			[{ selected: ["Red"], other: null }],
			timing,
		);
		assert.deepEqual(outcome, { ok: false, error: notShowing });
		assert.equal(tui.submitted, null);
	});

	it("validates answers before touching the session", async () => {
		assert.equal(validAnswers([colour], []), "Answer every question");
		assert.equal(
			validAnswers([colour], [{ selected: ["Purple"], other: null }]),
			"An answer is not one of the choices",
		);
		assert.equal(
			validAnswers([colour], [{ selected: ["Red", "Blue"], other: null }]),
			"“Colour” takes one answer",
		);
		assert.equal(
			validAnswers([colour], [{ selected: [], other: "  " }]),
			"Answer “Colour”",
		);
		assert.equal(
			validAnswers([colour], [{ selected: [], other: "a\u001bb" }]),
			"An answer cannot contain control characters",
		);
		assert.equal(
			validAnswers(
				[toppings],
				[{ selected: ["Cheese", "Olives"], other: "x" }],
			),
			null,
		);
		const tui = fakeTui({ questions: [colour] });
		const outcome = await answerQuestions(tui, [colour], [], timing);
		assert.equal(outcome.ok, false);
		assert.deepEqual(tui.sent, []);
	});
});
