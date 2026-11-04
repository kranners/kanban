import assert from "node:assert/strict";
import { test } from "node:test";
import { noticeText, removalText, undoKey } from "./undo.ts";

const press = (key: string, mods: Partial<Record<string, boolean>> = {}) => ({
	key,
	repeat: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	...mods,
});

test("cmd+z undoes and cmd+shift+z redoes on a Mac", () => {
	assert.equal(undoKey(press("z", { metaKey: true }), true), "undo");
	assert.equal(
		undoKey(press("Z", { metaKey: true, shiftKey: true }), true),
		"redo",
	);
	assert.equal(undoKey(press("z", { ctrlKey: true }), true), null);
	assert.equal(undoKey(press("y", { metaKey: true }), true), null);
});

test("ctrl+z undoes and ctrl+shift+z or ctrl+y redoes elsewhere", () => {
	assert.equal(undoKey(press("z", { ctrlKey: true }), false), "undo");
	assert.equal(
		undoKey(press("Z", { ctrlKey: true, shiftKey: true }), false),
		"redo",
	);
	assert.equal(undoKey(press("y", { ctrlKey: true }), false), "redo");
	assert.equal(undoKey(press("z", { metaKey: true }), false), null);
});

test("plain z, alt and other keys do nothing", () => {
	assert.equal(undoKey(press("z"), true), null);
	assert.equal(
		undoKey(press("z", { metaKey: true, altKey: true }), true),
		null,
	);
	assert.equal(undoKey(press("x", { ctrlKey: true }), false), null);
});

test("the notice says what was undone and what was left", () => {
	assert.equal(
		noticeText("undo", { ok: true, label: "Move a card", skipped: 0 }),
		"Undid: Move a card",
	);
	assert.equal(
		noticeText("redo", { ok: true, label: "Add 2 notes", skipped: 1 }),
		"Redid: Add 2 notes (left 1 thing that changed since)",
	);
	assert.equal(
		noticeText("undo", { ok: false, error: "Nothing to undo" }),
		"Nothing to undo",
	);
});

test("a removal's toast names what went, or counts it", () => {
	const noun: [string, string] = ["cloud session", "cloud sessions"];
	assert.equal(
		removalText("Archived", noun, ["Fix login"]),
		"Archived “Fix login”",
	);
	assert.equal(
		removalText("Archived", noun, [null]),
		"Archived a cloud session",
	);
	assert.equal(
		removalText("Archived", noun, ["Fix login", "Docs"]),
		"Archived 2 cloud sessions",
	);
	assert.equal(
		removalText("Deleted", ["sticker", "stickers"], [null]),
		"Deleted a sticker",
	);
});
