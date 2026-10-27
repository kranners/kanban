import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Annotations, Note, Sticker } from "../shared/types.ts";
import { gridSize } from "./grid.ts";
import {
	annotationCommand,
	broughtToFront,
	duplicated,
	gridStep,
	matchingStickers,
	maxAnnotationSize,
	minNoteSize,
	minStickerSize,
	moved,
	newNote,
	newSticker,
	noteFontSize,
	noteSize,
	noteSizeFor,
	recoloured,
	resized,
	retexted,
	sameAnnotation,
	sentToBack,
	stacked,
	stickerSize,
	topZ,
} from "./notes.ts";
import { near } from "./placement.ts";
import { stickerManifest } from "./stickers/manifest.ts";

const note = (id: string, z: number): Note => ({
	...newNote(id, { x: 0, y: 0 }, z),
	text: id,
});
const sticker = (id: string, z: number): Sticker =>
	newSticker(id, "rocket", { x: 0, y: 0 }, z);

const board = (...list: (Note | Sticker)[]): Annotations =>
	Object.fromEntries(list.map((a) => [a.id, a]));

const press = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
	key,
	repeat: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	...modifiers,
});

describe("new annotations", () => {
	it("centre on the point they are added at", () => {
		const added = newNote("a", { x: 500, y: 300 }, 4);
		assert.deepEqual(
			{ x: added.x, y: added.y, w: added.w, h: added.h, z: added.z },
			{
				x: 500 - noteSize / 2,
				y: 300 - noteSize / 2,
				w: noteSize,
				h: noteSize,
				z: 4,
			},
		);
		assert.equal(added.color, "yellow");
		assert.equal(added.text, "");
		const placed = newSticker("b", "fire", { x: 0, y: 0 }, 1);
		assert.deepEqual([placed.x, placed.w], [-stickerSize / 2, stickerSize]);
	});
});

describe("note sizes", () => {
	it("keeps short notes square", () => {
		assert.deepEqual(noteSizeFor("Ship it"), { w: noteSize, h: noteSize });
	});

	it("gives long notes room to read", () => {
		const report = newNote("r", { x: 0, y: 0 }, 1, "blue", "line\n".repeat(30));
		assert.ok(report.w > noteSize && report.h > noteSize);
		assert.deepEqual(
			[report.x, report.y],
			[-report.w / 2, Math.round(-report.h / 2)],
		);
		const huge = noteSizeFor("word ".repeat(4000));
		assert.ok(huge.h <= maxAnnotationSize && huge.w <= maxAnnotationSize);
	});
});

describe("stacking", () => {
	const all = board(note("a", 1), note("b", 5), sticker("c", 3));

	it("orders by z and finds the top", () => {
		assert.deepEqual(
			stacked(all).map((a) => a.id),
			["a", "c", "b"],
		);
		assert.equal(topZ(all), 5);
		assert.equal(topZ({}), 0);
	});

	it("brings a selection to the front keeping its order", () => {
		const raised = broughtToFront(all, ["c", "a"]);
		assert.deepEqual(
			raised.map((a) => [a.id, a.z]),
			[
				["a", 6],
				["c", 7],
			],
		);
	});

	it("sends a selection to the back keeping its order", () => {
		const lowered = sentToBack(all, ["b", "c"]);
		assert.deepEqual(
			lowered.map((a) => [a.id, a.z]),
			[
				["c", -2],
				["b", -1],
			],
		);
		assert.ok(lowered.every((a) => a.z < 1));
	});

	it("duplicates a selection on top, clear of everything taken", () => {
		let next = 0;
		const copies = duplicated(all, ["a", "missing"], () => `copy-${++next}`);
		assert.equal(copies.length, 1);
		const copy = copies[0];
		assert.ok(copy);
		assert.deepEqual({ id: copy.id, z: copy.z }, { id: "copy-1", z: 6 });
		for (const a of Object.values(all))
			assert.ok(!near(copy, a, 0), `the copy covers ${a.id}`);
	});

	it("duplicates a selection a grid step away when that is clear", () => {
		const [copy] = duplicated(all, ["a"], () => "copy", []);
		assert.deepEqual(
			[copy?.x, copy?.y],
			[(all.a?.x ?? 0) + gridSize, (all.a?.y ?? 0) + gridSize],
		);
	});

	it("keeps a duplicated selection's shape", () => {
		const spread = board(note("a", 1), {
			...sticker("c", 2),
			x: 400,
			y: 0,
		});
		const [first, second] = duplicated(spread, ["a", "c"], () => "copy");
		assert.ok(first && second);
		assert.deepEqual(
			[second.x - first.x, second.y - first.y],
			[
				(spread.c?.x ?? 0) - (spread.a?.x ?? 0),
				(spread.c?.y ?? 0) - (spread.a?.y ?? 0),
			],
		);
	});

	it("leaves a duplicated status report unlinked from its session or region", () => {
		const report = { ...note("a", 1), session: "s-1", region: "r-1" };
		const [copy] = duplicated(board(report), ["a"], () => "copy");
		assert.equal(copy?.kind === "note" && "session" in copy, false);
		assert.equal(copy?.kind === "note" && "region" in copy, false);
	});

	it("recolours only notes that change", () => {
		const coloured = recoloured(
			board(note("a", 1), { ...note("b", 2), color: "pink" }, sticker("c", 3)),
			["a", "b", "c"],
			"pink",
		);
		assert.deepEqual(
			coloured.map((a) => [a.id, a.color]),
			[["a", "pink"]],
		);
	});

	it("puts typed text on the latest saved note so another tab's move survives", () => {
		const typing = { ...note("a", 1), x: 521, text: "abcde" };
		const movedElsewhere = { ...note("a", 1), x: 821, text: "abcde" };
		assert.deepEqual(retexted(movedElsewhere, typing, "abcdef"), {
			...movedElsewhere,
			text: "abcdef",
		});
		assert.deepEqual(retexted(undefined, typing, "abcdef"), {
			...typing,
			text: "abcdef",
		});
	});
});

describe("geometry", () => {
	it("moves to whole board pixels", () => {
		const shifted = moved(note("a", 1), 10.4, -3.6);
		assert.deepEqual([shifted.x, shifted.y], [-96 + 10, -96 - 4]);
	});

	it("resizes notes freely within bounds", () => {
		const grown = resized(note("a", 1), 48, -1000);
		assert.deepEqual([grown.w, grown.h], [noteSize + 48, minNoteSize]);
		const huge = resized(note("a", 1), 1e6, 0);
		assert.equal(huge.w, maxAnnotationSize);
	});

	it("resizes stickers keeping their aspect ratio", () => {
		const wide = { ...sticker("s", 1), w: 200, h: 100 };
		const grown = resized(wide, 100, 10);
		assert.deepEqual([grown.w, grown.h], [300, 150]);
		const shrunk = resized(sticker("s", 1), -1000, -1000);
		assert.deepEqual([shrunk.w, shrunk.h], [minStickerSize, minStickerSize]);
	});

	it("fits text to the note", () => {
		const short = noteFontSize("Ship it", 192, 192);
		const long = noteFontSize("word ".repeat(80), 192, 192);
		assert.ok(short > long, `${short} > ${long}`);
		assert.ok(noteFontSize("Ship it", 384, 384) >= short);
		assert.equal(noteFontSize("x".repeat(2000), 96, 96), 11);
	});

	it("compares annotations regardless of key order", () => {
		const a = note("a", 1);
		const reordered = JSON.parse(
			JSON.stringify(Object.fromEntries(Object.entries(a).reverse())),
		) as Note;
		assert.ok(sameAnnotation(a, reordered));
		assert.ok(!sameAnnotation(a, { ...a, text: "other" }));
		assert.ok(sameAnnotation(undefined, undefined));
		assert.ok(!sameAnnotation(a, undefined));
	});
});

describe("sticker picker", () => {
	it("filters by name, id and keywords", () => {
		assert.deepEqual(
			matchingStickers(stickerManifest, "ship").map((s) => s.id),
			["rocket", "ship"],
		);
		assert.deepEqual(
			matchingStickers(stickerManifest, "  THUMBS up ").map((s) => s.id),
			["thumbs-up"],
		);
		assert.equal(
			matchingStickers(stickerManifest, "").length,
			stickerManifest.length,
		);
		assert.deepEqual(matchingStickers(stickerManifest, "zzz"), []);
	});

	it("moves through the grid without leaving it", () => {
		assert.equal(gridStep(0, "ArrowRight", 8, 20), 1);
		assert.equal(gridStep(0, "ArrowLeft", 8, 20), 0);
		assert.equal(gridStep(3, "ArrowDown", 8, 20), 11);
		assert.equal(gridStep(15, "ArrowDown", 8, 20), 15);
		assert.equal(gridStep(11, "ArrowUp", 8, 20), 3);
		assert.equal(gridStep(0, "Tab", 8, 20), 0);
		assert.equal(gridStep(0, "ArrowRight", 8, 0), 0);
	});

	it("has a unique id and a file for every sticker", () => {
		const ids = stickerManifest.map((s) => s.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(ids.length >= 40 && ids.length <= 60);
	});
});

describe("annotationCommand", () => {
	const none = { count: 0, notes: 0 };
	const oneNote = { count: 1, notes: 1 };

	it("adds notes and stickers without a selection", () => {
		assert.deepEqual(annotationCommand(press("n"), none), { kind: "note" });
		assert.deepEqual(annotationCommand(press("S"), none), { kind: "sticker" });
		assert.equal(annotationCommand(press("a"), none), null);
		assert.equal(annotationCommand(press("n", { repeat: true }), none), null);
		assert.equal(annotationCommand(press("n", { metaKey: true }), none), null);
	});

	it("acts on a selection", () => {
		assert.deepEqual(annotationCommand(press("Backspace"), oneNote), {
			kind: "delete",
		});
		assert.deepEqual(annotationCommand(press("Delete"), oneNote), {
			kind: "delete",
		});
		assert.deepEqual(
			annotationCommand(press("d", { metaKey: true }), oneNote),
			{
				kind: "duplicate",
			},
		);
		assert.deepEqual(
			annotationCommand(press("]", { ctrlKey: true }), oneNote),
			{
				kind: "front",
			},
		);
		assert.deepEqual(
			annotationCommand(press("[", { metaKey: true }), oneNote),
			{
				kind: "back",
			},
		);
		assert.deepEqual(annotationCommand(press("Enter"), oneNote), {
			kind: "edit",
		});
		assert.deepEqual(annotationCommand(press("Escape"), oneNote), {
			kind: "deselect",
		});
		assert.deepEqual(annotationCommand(press("ArrowLeft"), oneNote), {
			kind: "nudge",
			dx: -1,
			dy: 0,
		});
		assert.deepEqual(
			annotationCommand(
				press("ArrowDown", { shiftKey: true, repeat: true }),
				oneNote,
			),
			{ kind: "nudge", dx: 0, dy: gridSize },
		);
	});

	it("leaves keys alone without a fitting selection", () => {
		for (const key of ["Backspace", "Enter", "Escape", "ArrowUp"]) {
			assert.equal(annotationCommand(press(key), none), null, key);
		}
		assert.equal(annotationCommand(press("d", { metaKey: true }), none), null);
		assert.equal(
			annotationCommand(press("Enter"), { count: 1, notes: 0 }),
			null,
		);
		assert.equal(
			annotationCommand(press("Enter"), { count: 2, notes: 2 }),
			null,
		);
	});
});
