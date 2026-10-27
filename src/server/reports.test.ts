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
import type { Answer } from "./exit.ts";
import {
	createRegionReportRunner,
	createReportRunner,
	type RegionMembers,
	regionReportNote,
	regionReportText,
	reportNote,
	reportText,
} from "./reports.ts";

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

const region = {
	id: "region-1",
	cwd: "/Users/me/dev/acme-api",
	name: null,
	x: 0,
	y: 0,
	w: 480,
	h: 360,
};
const frame = { x: 0, y: 0, w: 480, h: 360 };
const at = new Date(2026, 9, 27, 14, 5);

describe("regionReportText", () => {
	it("heads each session's answer with its name, and says who did not answer", () => {
		assert.equal(
			regionReportText(
				[
					{ name: "api", answer: { ok: true, answer: " - done \n" } },
					{ name: "web", answer: { ok: false, error: "timed out" } },
				],
				at,
			),
			"**Status · 14:05**\n\n**api**\n\n- done\n\n**web**\n\n_No answer: timed out_",
		);
	});

	it("fits the note limit", () => {
		const text = regionReportText(
			[{ name: "api", answer: { ok: true, answer: "x".repeat(maxNoteText) } }],
			at,
		);
		assert.equal(text.length, maxNoteText);
		assert.ok(text.endsWith("…"));
	});
});

describe("regionReportNote", () => {
	it("places a new note beside the region, linked to it and not to a session", () => {
		const note = regionReportNote(
			region,
			frame,
			"- done",
			{},
			new Map(),
			() => "new",
		);
		assert.equal(note.region, region.id);
		assert.equal(note.session, undefined);
		assert.equal(note.x, 528);
		assert.equal(note.y, 0);
	});

	it("rewrites the region's earlier report, not a session's report", () => {
		const sessionReport: Note = { ...other, id: "s", session: session.id };
		const earlier: Note = { ...other, id: "r", x: 999, region: region.id };
		const note = regionReportNote(
			region,
			frame,
			"- later",
			{ s: sessionReport, r: earlier },
			new Map(),
			() => "new",
		);
		assert.equal(note.id, "r");
		assert.equal(note.x, 999);
		assert.equal(note.text, "- later");
	});
});

describe("createRegionReportRunner", () => {
	const runner = (
		members: () => RegionMembers | null,
		answer: (s: Session) => Answer,
		stored: Note[],
	) =>
		createRegionReportRunner({
			ask: async (s) => answer(s),
			annotations: {
				current: () => ({}),
				put: (note) => {
					stored.push(note as Note);
					return { ok: true };
				},
				remove: () => false,
				saved: async () => {},
			},
			members,
			cards: () => new Map(),
			audit: () => {},
			announce: () => {},
			now: () => at,
			newId: () => "new",
		});
	const second: Session = { ...session, id: "second", name: "acme-web" };

	it("notes every session's answer in one note, even when some fail", async () => {
		const stored: Note[] = [];
		const result = await runner(
			() => ({ frame, sessions: [session, second] }),
			(s) =>
				s.id === session.id
					? { ok: true, answer: "- done" }
					: { ok: false, error: "timed out" },
			stored,
		)(region, null);
		assert.deepEqual(result, { ok: true });
		assert.equal(stored.length, 1);
		assert.match(stored[0]?.text ?? "", /\*\*acme-api\*\*\n\n- done/);
		assert.match(
			stored[0]?.text ?? "",
			/\*\*acme-web\*\*\n\n_No answer: timed out_/,
		);
	});

	it("fails without a note when no session answers", async () => {
		const stored: Note[] = [];
		const result = await runner(
			() => ({ frame, sessions: [session] }),
			() => ({ ok: false, error: "timed out" }),
			stored,
		)(region, null);
		assert.deepEqual(result, { ok: false, error: "timed out" });
		assert.deepEqual(stored, []);
	});

	it("refuses an empty region without asking anyone", async () => {
		const asked: string[] = [];
		const result = await runner(
			() => ({ frame, sessions: [] }),
			(s) => {
				asked.push(s.id);
				return { ok: true, answer: "- done" };
			},
			[],
		)(region, null);
		assert.equal(result?.ok, false);
		assert.deepEqual(asked, []);
	});

	it("drops the answers when the region was deleted while they were asked", async () => {
		let calls = 0;
		const stored: Note[] = [];
		const result = await runner(
			() => (calls++ === 0 ? { frame, sessions: [session] } : null),
			() => ({ ok: true, answer: "- done" }),
			stored,
		)(region, null);
		assert.equal(result?.ok, false);
		assert.deepEqual(stored, []);
	});

	it("runs one report per region at a time", async () => {
		const run = runner(
			() => ({ frame, sessions: [session] }),
			() => ({ ok: true, answer: "- done" }),
			[],
		);
		const first = run(region, null);
		assert.equal(run(region, null), null);
		await first;
		assert.notEqual(run(region, null), null);
	});
});
