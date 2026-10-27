import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Annotations,
	maxNoteText,
	type Note,
	type Session,
} from "../shared/types.ts";
import { near } from "../web/placement.ts";
import { maxAnnotations } from "./annotations.ts";
import { createReportRunner, reportNote, reportText } from "./reports.ts";

const session: Session = {
	id: "11111111-2222-3333-4444-555555555555",
	short: "abcd1234",
	pid: 42,
	name: "acme-api",
	cwd: "/Users/me/dev/acme-api",
	project: "acme-api",
	kind: "background",
	activity: "working",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: true,
	cmux: false,
	artifacts: [],
};

const card = { x: 100, y: 205, w: 288, h: 168 };
const cards = new Map([[`session:${session.id}`, card]]);

const other: Note = {
	id: "other",
	kind: "note",
	x: 0,
	y: 0,
	w: 192,
	h: 192,
	z: 7,
	text: "unrelated",
	color: "yellow",
};

describe("reportNote", () => {
	it("places a new note a gap to the right of the card, on the grid, on top", () => {
		const note = reportNote(session, "- done", { other }, cards, () => "new");
		assert.deepEqual(
			{ ...note, w: undefined, h: undefined },
			{
				id: "new",
				kind: "note",
				x: 432,
				y: 216,
				w: undefined,
				h: undefined,
				z: 8,
				text: "- done",
				color: "blue",
				session: session.id,
			},
		);
	});

	it("rewrites the session's earlier report where it was left", () => {
		const earlier: Note = {
			...other,
			id: "earlier",
			x: -500,
			y: 40,
			color: "green",
			session: session.id,
		};
		const note = reportNote(
			session,
			"- newer",
			{ other, earlier },
			cards,
			() => "unused",
		);
		assert.equal(note.id, "earlier");
		assert.equal(note.x, -500);
		assert.equal(note.color, "green");
		assert.equal(note.text, "- newer");
	});

	it("moves to the nearest free space when a card or note is in the way", () => {
		const blocked = new Map([
			...cards,
			["session:neighbour", { x: 432, y: 216, w: 288, h: 168 }],
		]);
		const note = reportNote(session, "- done", { other }, blocked, () => "n");
		const rect = { x: note.x, y: note.y, w: note.w, h: note.h };
		for (const taken of [...blocked.values(), other]) {
			assert.ok(!near(rect, taken, 24), JSON.stringify({ rect, taken }));
		}
		assert.equal(note.x % 24, 0);
		assert.equal(note.y % 24, 0);
	});

	it("falls back to the origin when the card is not placed", () => {
		const note = reportNote(session, "x", {}, new Map(), () => "new");
		assert.deepEqual([note.x, note.y], [0, 0]);
	});
});

describe("reportText", () => {
	it("heads the answer with the time and fits the note limit", () => {
		const at = new Date(2026, 9, 27, 9, 3);
		assert.equal(reportText("  - a\n", at), "**Status · 09:03**\n\n- a");
		const long = reportText("x".repeat(maxNoteText), at);
		assert.equal(long.length, maxNoteText);
		assert.ok(long.endsWith("…"));
	});
});

describe("createReportRunner", () => {
	const runner = (
		annotations: Annotations,
		cardsNow: ReadonlyMap<string, typeof card>,
		asked: string[],
	) =>
		createReportRunner({
			ask: async (s) => {
				asked.push(s.id);
				return { ok: true, answer: "- done" };
			},
			annotations: {
				current: () => annotations,
				put: () => ({ ok: true }),
				remove: () => false,
				saved: async () => {},
			},
			cards: () => cardsNow,
			audit: () => {},
			announce: () => {},
		});

	it("refuses a full board before asking the session", async () => {
		const asked: string[] = [];
		const full = Object.fromEntries(
			Array.from({ length: maxAnnotations }, (_, i) => [
				`n${i}`,
				{ ...other, id: `n${i}` },
			]),
		);
		const result = await runner(full, cards, asked)(session, null);
		assert.equal(result?.ok, false);
		assert.deepEqual(asked, []);
	});

	it("drops the answer when the card left the board while it was asked", async () => {
		const asked: string[] = [];
		const result = await runner({}, new Map(), asked)(session, null);
		assert.deepEqual(result, {
			ok: false,
			error: "The session left the board before its status report arrived",
		});
		assert.deepEqual(asked, [session.id]);
	});
});
