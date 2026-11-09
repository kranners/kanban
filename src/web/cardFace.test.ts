import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ButlerCard } from "../shared/types.ts";
import {
	butlerCardAuthor,
	butlerCardLastActivity,
	cardAuthorKinds,
	dimmedByAuthor,
	sessionAuthor,
	sessionLastActivity,
	stalledText,
	stallMs,
	statusOf,
} from "./cardFace.ts";

const minute = 60_000;

/** A Butler card as boards saved them before every card shared one face: no author, no new field. */
const savedCard: ButlerCard = {
	id: "thread-1300000000000000001",
	kind: "butler-card",
	title: "Book the bike service",
	state: "working",
	status: "reading mail",
	x: -1240,
	y: 96,
	w: 312,
	h: 216,
	z: 7,
	updatedAt: 1_000_000,
	thread: {
		id: "1300000000000000001",
		kind: "conversation",
		link: "https://discord.com/channels/1/2/3",
		private: false,
	},
};

describe("who started a card", () => {
	it("is Kanban for Aaron's own board sessions", () => {
		assert.deepEqual(sessionAuthor({}), { kind: "kanban", label: "Kanban" });
	});

	it("is Butler, naming the thread, for a session a Butler thread started", () => {
		assert.deepEqual(
			sessionAuthor({
				parent: {
					thread: "123456",
					title: "Fix the gate",
					card: "thread-123456",
				},
			}),
			{ kind: "butler", label: "Butler", from: "Fix the gate" },
		);
	});

	it("is the desk session for a session a desk session started", () => {
		assert.deepEqual(
			sessionAuthor({
				parent: { thread: "123456", desk: "1109-2", card: "thread-123456" },
			}),
			{ kind: "desk", label: "Desk 1109-2" },
		);
	});

	it("reads an old saved Butler card's author from the fields it already had", () => {
		assert.equal(butlerCardAuthor(savedCard).kind, "butler");
		assert.equal(
			butlerCardAuthor({
				...savedCard,
				thread: undefined,
				selfFix: "20261109-1",
			}).kind,
			"change",
		);
		assert.deepEqual(butlerCardAuthor({ ...savedCard, desk: "1105-3" }), {
			kind: "desk",
			label: "Desk 1105-3",
		});
		assert.equal(
			butlerCardAuthor({
				...savedCard,
				thread: {
					...(savedCard.thread as NonNullable<ButlerCard["thread"]>),
					kind: "desk",
				},
			}).kind,
			"desk",
		);
		for (const kind of ["scheduled", "job", "voice", "dm", "board"] as const) {
			assert.equal(
				butlerCardAuthor({
					...savedCard,
					thread: {
						...(savedCard.thread as NonNullable<ButlerCard["thread"]>),
						kind,
					},
				}).kind,
				"butler",
			);
		}
	});

	it("keeps an old saved card's id and place: nothing about it is rewritten", () => {
		const before = structuredClone(savedCard);
		butlerCardAuthor(savedCard);
		butlerCardLastActivity(savedCard);
		assert.deepEqual(savedCard, before);
	});
});

describe("stalled", () => {
	it("is working with nothing new for over ten minutes", () => {
		assert.equal(stallMs, 10 * minute);
		assert.equal(statusOf("working", 0, 10 * minute), "working");
		assert.equal(statusOf("working", 0, 10 * minute + 1), "stalled");
	});

	it("never marks a pause between turns, a question or a finished card", () => {
		for (const activity of [
			"idle",
			"needs-you",
			"done",
			"failed",
			"stopped",
			"watching",
		] as const) {
			assert.equal(statusOf(activity, 0, 60 * minute), activity);
		}
	});

	it("counts a session's subagents' steps as activity, and only its own", () => {
		const session = { id: "s1", updatedAt: 0 };
		const last = sessionLastActivity(
			session,
			[
				{ sessionId: "s1", updatedAt: 9 * minute, live: false },
				{ sessionId: "s2", updatedAt: 30 * minute, live: true },
			],
			15 * minute,
		);
		assert.equal(last, 9 * minute);
		assert.equal(statusOf("working", last, 15 * minute), "working");
	});

	it("never stalls a session while a tool call or subagent of its own still runs", () => {
		const now = 30 * minute;
		const quiet = { id: "s1", updatedAt: 0 };
		assert.equal(
			statusOf(
				"working",
				sessionLastActivity({ ...quiet, toolRunning: true }, [], now),
				now,
			),
			"working",
		);
		assert.equal(
			statusOf(
				"working",
				sessionLastActivity(
					quiet,
					[{ sessionId: "s1", updatedAt: 0, live: true }],
					now,
				),
				now,
			),
			"working",
		);
		assert.equal(
			statusOf("working", sessionLastActivity(quiet, [], now), now),
			"stalled",
		);
	});

	it("counts a Butler card's newest event and subagent as activity", () => {
		assert.equal(
			butlerCardLastActivity({
				updatedAt: 1000,
				history: [{ at: 4000, state: "working" }],
				subagents: [
					{
						id: "a",
						description: "",
						type: "Agent",
						state: "working",
						startedAt: 0,
						updatedAt: 7000,
					},
				],
			}),
			7000,
		);
	});

	it("trusts the daemon's last activity over when the board last stored or restated a Butler card", () => {
		const card = {
			updatedAt: 30 * minute,
			lastActiveAt: 2 * minute,
			history: [{ at: 30 * minute, state: "working" as const }],
		};
		const last = butlerCardLastActivity(card);
		assert.equal(last, 2 * minute);
		assert.equal(statusOf("working", last, 14 * minute), "stalled");
	});

	it("says how long it has stalled, in minutes", () => {
		assert.equal(stalledText(0, 14 * minute + 59_000), "Stalled 14 min");
	});
});

describe("the author filter", () => {
	it("dims every card but the chosen author's, and none when showing all", () => {
		const butler = butlerCardAuthor(savedCard);
		const kanban = sessionAuthor({});
		assert.equal(dimmedByAuthor(butler, "all"), false);
		assert.equal(dimmedByAuthor(butler, "butler"), false);
		assert.equal(dimmedByAuthor(kanban, "butler"), true);
	});
});

describe("status colours", () => {
	const css = ["styles.css", "attention.css"]
		.map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
		.join("\n");

	it("gives every status a colour, stalled its own", () => {
		for (const status of [
			"working",
			"needs-you",
			"idle",
			"done",
			"failed",
			"stalled",
		]) {
			assert.match(css, new RegExp(`\\.act-${status} \\{\\s*--act:`), status);
		}
		assert.match(
			css,
			/\.node\.session\.act-stalled \.frame \{[^}]*--stalled-edge/,
		);
		assert.match(css, /\.ribbon\.act-stalled \{/);
	});

	it("draws Butler's cards in the session face, with no colour of their own", () => {
		const butlerCss = readFileSync(
			new URL("butler.css", import.meta.url),
			"utf8",
		);
		const card =
			butlerCss.match(/\.annotation\.butler-card \{[^}]*\}/)?.[0] ?? "";
		assert.doesNotMatch(card, /--butler|border/);
		assert.doesNotMatch(butlerCss, /\.butler-card-body/);
	});

	it("has a chip for every author", () => {
		const face = readFileSync(new URL("CardFace.tsx", import.meta.url), "utf8");
		for (const kind of cardAuthorKinds) {
			assert.match(face, new RegExp(`case "${kind}":`), kind);
		}
	});
});
