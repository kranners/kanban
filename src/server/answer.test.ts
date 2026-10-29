import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AskQuestion } from "../shared/conversation.ts";
import {
	answerQuestions,
	choosePermission,
	notShowing,
	notSubmitted,
	readQuestionShapes,
	validAnswers,
} from "./answer.ts";
import { fakeTui } from "./fakeTui.ts";

const timing = { pollMs: 1, settleMs: 40 };

const patientTiming = { pollMs: 1, settleMs: 2000 };

const anyPrompt = () => true;

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

const shade: AskQuestion = {
	...colour,
	question: "Pick a shade",
	header: "Shade",
};

const unshaped = (question: AskQuestion): AskQuestion => ({
	...question,
	header: "",
	multiSelect: false,
});

const permissionOptions = [
	"Yes",
	"Yes, and always allow access to /tmp/demo from this project",
	"No",
];

describe("answering a permission prompt", () => {
	it("moves to the chosen option and confirms it", async () => {
		const tui = fakeTui({ permission: permissionOptions });
		const outcome = await choosePermission(tui, 2, "No", anyPrompt, timing);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.equal(tui.chosen, "No");
	});

	it("keeps the default choice with a single Enter", async () => {
		const tui = fakeTui({ permission: permissionOptions });
		assert.equal(
			(await choosePermission(tui, 0, "Yes", anyPrompt, timing)).ok,
			true,
		);
		assert.equal(tui.chosen, "Yes");
	});

	it("waits out a slow redraw before confirming", async () => {
		const tui = fakeTui({ permission: permissionOptions, lagReads: 3 });
		assert.equal(
			(
				await choosePermission(
					tui,
					1,
					permissionOptions[1] ?? "",
					anyPrompt,
					patientTiming,
				)
			).ok,
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
			anyPrompt,
			timing,
		);
		assert.deepEqual(outcome, { ok: false, error: notShowing });
		assert.equal(tui.chosen, null);
		const other = fakeTui({ permission: permissionOptions });
		assert.deepEqual(
			await choosePermission(other, 0, "Yes", () => false, timing),
			{ ok: false, error: notShowing },
		);
		assert.equal(other.chosen, null);
		const closed = fakeTui({});
		assert.equal(
			(await choosePermission(closed, 0, "Yes", anyPrompt, timing)).ok,
			false,
		);
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

	it("passes a multi-select question that is not the last with Next", async () => {
		const tui = fakeTui({ questions: [toppings, colour] });
		const outcome = await answerQuestions(
			tui,
			[toppings, colour],
			[
				{ selected: ["Olives"], other: null },
				{ selected: ["Red"], other: null },
			],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.submitted, {
			"Pick toppings": "Olives",
			"Pick a colour": "Red",
		});
	});

	it("answers a long question the TUI quotes over several lines", async () => {
		const long: AskQuestion = {
			...colour,
			question:
				"The build needs `docker run`, and the daemon has stopped answering after its VM ran out of memory. Which colour should the restart banner be?",
		};
		const tui = fakeTui({ questions: [long] });
		const outcome = await answerQuestions(
			tui,
			[long],
			[{ selected: ["Green"], other: null }],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.submitted, { [long.question]: "Green" });
	});

	it("answers beside Claude Code's diff panel", async () => {
		const long: AskQuestion = {
			...colour,
			question:
				"The banner shows while the daemon restarts after its VM ran out of memory. Which colour should it be?",
		};
		const questions = [colour, long, toppings];
		const tui = fakeTui({
			questions,
			sidePanel: [
				"──────────────────────────────",
				"New file not yet staged.",
				"Run `git add :/data/delta.tsv` to see line counts.",
				"",
				"data/delta.tsv (untracked)",
			],
		});
		const outcome = await answerQuestions(
			tui,
			questions,
			[
				{ selected: ["Red"], other: null },
				{ selected: [], other: "Teal, then grey once it is back" },
				{ selected: ["Olives"], other: null },
			],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.submitted, {
			"Pick a colour": "Red",
			[long.question]: "Teal, then grey once it is back",
			"Pick toppings": "Olives",
		});
	});

	it("refuses rather than reporting success when the review does not submit", async () => {
		const tui = fakeTui({ questions: [colour, toppings] });
		const press = tui.keys;
		tui.keys = (keys) =>
			tui.state?.kind === "ask" && tui.state.review
				? Promise.resolve({ ok: true, value: null })
				: press(keys);
		const outcome = await answerQuestions(
			tui,
			[colour, toppings],
			[
				{ selected: ["Green"], other: null },
				{ selected: ["Cheese"], other: null },
			],
			timing,
		);
		assert.deepEqual(outcome, { ok: false, error: notSubmitted });
		assert.equal(tui.submitted, null);
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

	it("submits the review that a lone multi-select question ends on", async () => {
		const tui = fakeTui({ questions: [toppings] });
		const outcome = await answerQuestions(
			tui,
			[toppings],
			[{ selected: ["Cheese", "Basil"], other: "Anchovies" }],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.submitted, {
			"Pick toppings": "Cheese, Basil, Anchovies",
		});
	});

	it("toggles a multi-select question that the job state lists without its type", async () => {
		const tui = fakeTui({ questions: [colour, toppings] });
		const outcome = await answerQuestions(
			tui,
			[colour, toppings].map(unshaped),
			[
				{ selected: ["Blue"], other: null },
				{ selected: ["Olives"], other: null },
			],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.submitted, {
			"Pick a colour": "Blue",
			"Pick toppings": "Olives",
		});
	});

	it("refuses several picks for a question the screen shows as single-select", async () => {
		const tui = fakeTui({ questions: [colour] });
		const outcome = await answerQuestions(
			tui,
			[{ ...colour, multiSelect: true }],
			[{ selected: ["Red", "Blue"], other: null }],
			timing,
		);
		assert.deepEqual(outcome, {
			ok: false,
			error: "“Colour” takes one answer",
		});
		assert.equal(tui.submitted, null);
	});

	it("goes back to the first question when an earlier attempt left the prompt further on", async () => {
		const tui = fakeTui({ questions: [colour, toppings] });
		assert.ok(tui.state?.kind === "ask");
		tui.state.typed[0] = "Teal";
		tui.state.tab = 1;
		const outcome = await answerQuestions(
			tui,
			[colour, toppings],
			[
				{ selected: [], other: "Teal" },
				{ selected: ["Cheese"], other: null },
			],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.sent, [], "the typed answer is not pasted twice");
		assert.deepEqual(tui.submitted, {
			"Pick a colour": "Teal",
			"Pick toppings": "Cheese",
		});
	});

	it("refuses rather than adding to a different answer already typed", async () => {
		const tui = fakeTui({ questions: [colour] });
		assert.ok(tui.state?.kind === "ask");
		tui.state.typed[0] = "Teal";
		const outcome = await answerQuestions(
			tui,
			[colour],
			[{ selected: [], other: "Navy" }],
			timing,
		);
		assert.equal(outcome.ok, false);
		assert.deepEqual(tui.sent, []);
		assert.equal(tui.submitted, null);
	});

	it("refuses rather than submitting a shorter answer already typed", async () => {
		const tui = fakeTui({ questions: [colour] });
		assert.ok(tui.state?.kind === "ask");
		tui.state.typed[0] = "Navy";
		const outcome = await answerQuestions(
			tui,
			[colour],
			[{ selected: [], other: "Navy blue with stripes" }],
			timing,
		);
		assert.equal(outcome.ok, false);
		assert.equal(tui.submitted, null);
	});

	it("refuses rather than submitting a typed answer left in a multi-select question", async () => {
		const tui = fakeTui({ questions: [toppings] });
		assert.ok(tui.state?.kind === "ask");
		tui.state.typed[0] = "Anchovies";
		const outcome = await answerQuestions(
			tui,
			[toppings],
			[{ selected: ["Cheese"], other: null }],
			timing,
		);
		assert.equal(outcome.ok, false);
		assert.equal(tui.submitted, null);
	});

	it("tells apart questions where one's text starts with the other's", async () => {
		const border: AskQuestion = {
			...shade,
			question: "Pick a colour for the border",
		};
		const tui = fakeTui({ questions: [colour, border] });
		const outcome = await answerQuestions(
			tui,
			[colour, border],
			[
				{ selected: ["Red"], other: null },
				{ selected: ["Green"], other: null },
			],
			timing,
		);
		assert.deepEqual(outcome, { ok: true, value: null });
		assert.deepEqual(tui.submitted, {
			"Pick a colour": "Red",
			"Pick a colour for the border": "Green",
		});
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

describe("reading question types off the screen", () => {
	it("reads each question's header and type, then returns to the question it started on", async () => {
		const questions = [colour, toppings, shade];
		const tui = fakeTui({ questions });
		await tui.keys(["Tab"]);
		const read = await readQuestionShapes(tui, questions.map(unshaped), timing);
		assert.deepEqual(read, {
			ok: true,
			value: [
				{ header: "Colour", multiSelect: false },
				{ header: "Toppings", multiSelect: true },
				{ header: "Shade", multiSelect: false },
			],
		});
		assert.ok(tui.state?.kind === "ask");
		assert.equal(tui.state.tab, 1);
		assert.equal(tui.submitted, null);
	});

	it("leaves a typed answer's row before switching questions", async () => {
		const questions = [colour, toppings];
		const tui = fakeTui({ questions });
		assert.ok(tui.state?.kind === "ask");
		tui.state.cursor = colour.options.length;
		const read = await readQuestionShapes(tui, questions, timing);
		assert.equal(read.ok, true);
		assert.deepEqual(tui.sent, []);
	});

	it("refuses when the prompt on screen is not one of the questions", async () => {
		const tui = fakeTui({ questions: [toppings] });
		const read = await readQuestionShapes(tui, [colour], timing);
		assert.deepEqual(read, { ok: false, error: notShowing });
	});
});
