import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureNow, sheetFixtures } from "./fixtures.ts";
import { cardSize, parseSheetInput } from "./input.ts";

const parse = (value: unknown) => parseSheetInput(JSON.stringify(value));

const parsed = (value: unknown) => {
	const result = parse(value);
	if (!result.ok) throw new Error(result.error);
	return result.input;
};

describe("parseSheetInput", () => {
	it("reads each thread card through the board's own mapping", () => {
		const input = parsed(sheetFixtures().cards);
		assert.equal(input.kind, "cards");
		assert.equal(input.width, 960);
		assert.equal(input.cards.length, 5);
		const [first, second] = input.cards;
		assert.equal(first?.card.id, "thread-200000000000000001");
		assert.equal(first?.card.kind, "butler-card");
		assert.equal(first?.card.w, cardSize.w);
		assert.equal(first?.view.author.kind, "butler");
		assert.equal(first?.view.status, "working");
		assert.equal(first?.view.doing, "Reading the valve logs");
		assert.deepEqual(first?.card.machines, ["piggy", "browser"]);
		assert.equal(first?.linked, 1);
		assert.deepEqual(
			first?.chips.shown.map((s) => s.description),
			["Read the valve logs", "Draft the new schedule"],
		);
		assert.equal(second?.card.parent, "thread-200000000000000001");
		assert.equal(second?.view.author.kind, "desk");
		assert.equal(second?.view.needs, "Which Saturday suits?");
		assert.equal(second?.card.engine, "Codex · Sol");
	});

	it("draws a card with no Discord thread yet without inventing its link", () => {
		const input = parsed(sheetFixtures().cards);
		const desk = input.cards[4];
		assert.equal(desk?.card.title, "Sort the receipts folder");
		assert.equal(desk?.card.link, undefined);
		assert.equal(desk?.view.status, "stalled");
	});

	it("never carries a thread's events or approvals", () => {
		const card = {
			...sheetFixtures().cards.cards[0],
			events: [{ at: fixtureNow, kind: "aaron", text: "private words" }],
			approvals: [{ at: fixtureNow, headline: "Allow a send" }],
		};
		const input = parsed({ kind: "cards", now: fixtureNow, cards: [card] });
		assert.doesNotMatch(JSON.stringify(input), /private words|Allow a send/);
	});

	it("draws one card as a strip", () => {
		const input = parsed({
			...sheetFixtures().cards,
			kind: "strip",
			theme: "light",
		});
		assert.equal(input.kind, "strip");
		assert.equal(input.theme, "light");
		assert.equal(input.cards.length, 1);
	});

	it("works out a project's dashboard with the sheet's cards as its live work", () => {
		const input = parsed(sheetFixtures().dashboard);
		assert.equal(input.dashboard?.project.id, "garden");
		assert.equal(input.dashboard?.project.blockedOn, null);
		const work = input.dashboard?.dash.work.map((w) => w.title).sort();
		assert.deepEqual(work, [
			"Book the bike service",
			"Tidy the garden watering schedule",
		]);
		assert.equal(input.dashboard?.dash.children[0]?.id, "garden-sensors");
		assert.equal(input.dashboard?.dash.graph.nodes.length, 5);
	});

	it("takes projects in the board's own shape too", () => {
		const fixture = sheetFixtures().dashboard;
		const board = parsed(fixture).dashboard?.project;
		const again = parsed({
			...fixture,
			dashboard: { ...fixture.dashboard, projects: [board] },
		}).dashboard?.project;
		assert.equal(again?.stageSince, board?.stageSince);
		assert.equal(again?.touchedAt, board?.touchedAt);
		assert.deepEqual(again?.links, board?.links);
		assert.equal(again?.graph?.updatedAt, board?.graph?.updatedAt);
	});

	it("drops a report's screenshots, which a picture never loads", () => {
		const input = parsed(sheetFixtures().report);
		assert.equal(input.report?.title, "Garden automation");
		assert.deepEqual(input.report?.shots, []);
	});

	it("says why it cannot draw bad input", () => {
		const cases: [unknown, RegExp][] = [
			["nope", /object/],
			[{ kind: "poster", now: 1 }, /kind must be one of/],
			[{ kind: "cards", cards: [] }, /now must be/],
			[{ kind: "cards", now: 1, cards: [] }, /at least one card/],
			[{ kind: "cards", now: 1, theme: "blue", cards: [] }, /theme/],
			[{ kind: "cards", now: 1, width: 5, cards: [] }, /width/],
			[
				{ kind: "cards", now: 1, cards: [{ title: "x", kind: "dm" }] },
				/card 1 is not a thread card/,
			],
			[
				{
					kind: "dashboard",
					now: 1,
					dashboard: { projects: [], project: "x" },
				},
				/names no project/,
			],
			[{ kind: "report", now: 1, report: { title: "x" } }, /status report/],
		];
		for (const [value, error] of cases) {
			const result = parse(value);
			assert.equal(result.ok, false, JSON.stringify(value));
			if (!result.ok) assert.match(result.error, error);
		}
		const notJson = parseSheetInput("{");
		assert.equal(notJson.ok, false);
	});
});
