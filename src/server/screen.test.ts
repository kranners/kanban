import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moves, permissionMode, readDialog, sameLabel } from "./screen.ts";

const rule = "─".repeat(80);
const dashes = "╌".repeat(80);

const bashPrompt = [
	"❯ Use the Bash tool to run exactly: echo hi > out.txt",
	"",
	'  Creating out.txt with "hi" content',
	"  ⎿  $ echo hi > out.txt",
	"",
	rule,
	" Bash command",
	' Create out.txt with "hi" content',
	dashes,
	" echo hi > out.txt",
	dashes,
	" Do you want to proceed?",
	"   1. Yes",
	" ❯ 2. Yes, and always allow access to /tmp/demo from this project",
	"   3. No",
	"",
	" Esc to cancel · Tab to amend",
	"",
	"",
].join("\n");

const multiQuestion = [
	rule,
	"←  ☒ Colour  ☐ Toppings  ✔ Submit  →",
	"Pick toppings",
	"  1. [✔] Cheese",
	"         A dairy topping",
	"  2. [ ] Olives",
	"         A brined fruit",
	"❯ 3. [ ] Basil",
	"         A fresh herb",
	"  4. [✔] anchovies",
	"     Submit",
	rule,
	"  5. Chat about this",
	"Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

const singleQuestion = [
	"❯ Ask me which fruit",
	rule,
	" ☐ Fruit ",
	"Which fruit?",
	"❯ 1. Apple",
	"     a crisp round fruit",
	"  2. Pear",
	"     a sweet bell-shaped fruit",
	"  3. Type something.",
	rule,
	"  4. Chat about this",
	"Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

const review = [
	"←  ☒ Colour  ☒ Toppings  ✔ Submit  →",
	"Review your answers",
	" ● Pick a colour",
	"   → Green",
	"Ready to submit your answers?",
	"❯ 1. Submit answers",
	"  2. Cancel",
].join("\n");

const idle = [
	"  1. First the plan",
	"  2. Then the work",
	"✻ Baked for 6s",
	rule,
	"❯ ",
	rule,
	"  Model · demo",
	"  ⏵⏵ accept edits on (shift+tab to cycle) · ← 2 agents",
].join("\n");

describe("reading the TUI's screen", () => {
	it("reads a permission prompt's question, choices and cursor", () => {
		assert.deepEqual(readDialog(bashPrompt), {
			kind: "choice",
			question: "Do you want to proceed?",
			options: [
				"Yes",
				"Yes, and always allow access to /tmp/demo from this project",
				"No",
			],
			cursor: 1,
			complete: true,
			body: [
				"Bash command",
				' Create out.txt with "hi" content',
				" echo hi > out.txt",
			].join("\n"),
		});
	});

	it("joins wrapped choices and notices a list clipped by a tiny pane", () => {
		const tiny = [
			" Do you want to proceed?",
			" ❯ 1. Yes",
			" ↓ 2. Yes, and always allow",
			"      access to /private/tmp",
			"      /demo from this",
			"      project",
			"",
			" Esc to cancel · Tab to ",
			" amend",
		].join("\n");
		const dialog = readDialog(tiny);
		assert.deepEqual(dialog, {
			kind: "choice",
			question: "Do you want to proceed?",
			options: [
				"Yes",
				"Yes, and always allow access to /private/tmp /demo from this project",
			],
			cursor: 0,
			complete: false,
			body: "",
		});
		assert.equal(
			sameLabel(
				dialog?.kind === "choice" ? (dialog.options[1] ?? "") : "",
				"Yes, and always allow access to /private/tmp/demo from this project",
			),
			true,
		);
		const scrolled = readDialog(
			" Do you want to proceed?\n ↑ 2. Yes, always\n ❯ 3. No\n\n Esc",
		);
		assert.deepEqual(scrolled?.kind === "choice" && scrolled.options, [
			"",
			"Yes, always",
			"No",
		]);
		assert.equal(scrolled?.kind === "choice" && scrolled.cursor, 2);
	});

	it("reads a multi-select question with checked rows and the submit row", () => {
		const dialog = readDialog(multiQuestion);
		assert.equal(dialog?.kind, "ask");
		if (dialog?.kind !== "ask") return;
		assert.deepEqual(dialog.tabs, ["Colour", "Toppings"]);
		assert.equal(dialog.question, "Pick toppings");
		assert.equal(dialog.review, false);
		assert.deepEqual(
			dialog.rows.map((row) => [
				row.number,
				row.label,
				row.checked,
				row.cursor,
			]),
			[
				[1, "Cheese", true, false],
				[2, "Olives", false, false],
				[3, "Basil", false, true],
				[4, "anchovies", true, false],
				[null, "Submit", null, false],
				[5, "Chat about this", null, false],
			],
		);
	});

	it("reads a lone question and the review step", () => {
		const single = readDialog(singleQuestion);
		assert.equal(single?.kind === "ask" && single.question, "Which fruit?");
		assert.deepEqual(
			single?.kind === "ask" && single.rows.map((row) => row.label),
			["Apple", "Pear", "Type something.", "Chat about this"],
		);
		const reviewed = readDialog(review);
		assert.equal(reviewed?.kind === "ask" && reviewed.review, true);
		assert.deepEqual(
			reviewed?.kind === "ask" && reviewed.rows.map((row) => row.label),
			["Submit answers", "Cancel"],
		);
	});

	it("finds no dialog in an ordinary screen or a numbered list without a cursor", () => {
		assert.equal(readDialog(idle), null);
		assert.equal(readDialog(""), null);
	});

	it("ignores a numbered list in the conversation above the input box", () => {
		const echoed = [
			"❯ 1. Pick the plan",
			"  2. Then the work",
			"",
			"⏺ On it.",
			rule,
			"❯ ",
			rule,
			"  ⏸ manual mode on",
		].join("\n");
		assert.equal(readDialog(echoed), null);
	});

	it("reads a menu that is not a numbered prompt, such as Rewind", () => {
		const rewind = [
			"⏺ Done.",
			"✻ Worked for 4s · done 5:19 pm",
			`${"▔".repeat(70)} Image in clipboard · ctrl+v to paste ▔`,
			"   Rewind",
			"",
			" Restore the code and/or conversation to the point before…",
			"",
			" ❯ (current)",
			"",
			" Enter to continue · Esc to cancel",
		].join("\n");
		assert.deepEqual(readDialog(rewind), { kind: "menu", title: "Rewind" });
		const quoted = [
			"⏺ Press Esc to cancel the picker.",
			rule,
			"❯ ",
			rule,
			"  ⏸ manual mode on",
		].join("\n");
		assert.equal(readDialog(quoted), null);
	});

	it("reads the permission mode from the footer", () => {
		assert.equal(permissionMode(idle), "accept edits");
		assert.equal(
			permissionMode("❯ \n  ⏸ plan mode on (shift+tab to cycle)"),
			"plan",
		);
		assert.equal(
			permissionMode("❯ \n  ⏸ manual mode on · ← 2 agents"),
			"manual",
		);
		assert.equal(permissionMode("❯ \n  ? for shortcuts"), null);
	});

	it("matches labels the TUI cut short", () => {
		assert.equal(
			sameLabel(
				"Yes, and always allow access to /tmp/de…",
				"Yes, and always allow access to /tmp/demo from this project",
			),
			true,
		);
		assert.equal(sameLabel("Yes", "Yes"), true);
		assert.equal(sameLabel("No", "Yes"), false);
		assert.equal(sameLabel("", "Yes"), false);
	});

	it("plans arrow moves between rows", () => {
		assert.deepEqual(moves(0, 2), ["Down", "Down"]);
		assert.deepEqual(moves(3, 1), ["Up", "Up"]);
		assert.deepEqual(moves(1, 1), []);
	});
});
