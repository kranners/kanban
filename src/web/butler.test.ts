import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Annotations,
	type ButlerCard,
	type ButlerPresence,
	type CommentThread,
	noButler,
} from "../shared/types.ts";
import { presenceOf } from "./butler.ts";

const card = (id: string, fields: Partial<ButlerCard> = {}): ButlerCard => ({
	id,
	kind: "butler-card",
	x: 0,
	y: 0,
	w: 312,
	h: 216,
	z: 1,
	title: id,
	state: "idle",
	updatedAt: 0,
	...fields,
});

const thread = (id: string, fields: Partial<CommentThread>): CommentThread => ({
	id,
	x: 0,
	y: 0,
	to: "butler",
	events: [],
	resolved: false,
	running: false,
	sessionId: "",
	resumable: false,
	createdAt: 0,
	updatedAt: 0,
	...fields,
});

const presence = (fields: Partial<ButlerPresence>): ButlerPresence => ({
	...noButler,
	...fields,
});

test("Butler's cursor stays where he last acted for two minutes", () => {
	const state = presence({
		working: { target: "s1", label: "Butler", at: 1000 },
	});
	const { cursor, face } = presenceOf(state, {}, [], 1000 + 60_000);
	assert.deepEqual(cursor, { target: "s1", label: "Butler" });
	assert.deepEqual(face, cursor);
	assert.equal(presenceOf(state, {}, [], 1000 + 121_000).cursor, null);
});

test("on a change card his cursor says so", () => {
	const annotations: Annotations = {
		f: card("f", { selfFix: "20261103-014125-2712401" }),
	};
	const state = presence({ working: { target: "f", label: "Butler", at: 0 } });
	assert.deepEqual(presenceOf(state, annotations, [], 10).cursor, {
		target: "f",
		label: "Butler (change)",
	});
});

test("his face follows what Aaron is working on while his cursor works elsewhere", () => {
	const state = presence({
		working: { target: "s1", label: "Butler", at: 0 },
		following: "s2",
	});
	const where = presenceOf(state, {}, [], 10);
	assert.equal(where.cursor?.target, "s1");
	assert.equal(where.face?.target, "s2");
	assert.equal(where.following, true);
});

test("his face goes where he looks for two minutes, then back to Aaron", () => {
	const state = presence({
		looking: { target: "s3", label: "Butler", at: 0 },
		following: "s2",
	});
	assert.equal(presenceOf(state, {}, [], 10).face?.target, "s3");
	assert.equal(presenceOf(state, {}, [], 10).following, false);
	assert.equal(presenceOf(state, {}, [], 121_000).face?.target, "s2");
});

test("while he answers a message his cursor sits on what it was about", () => {
	const annotations: Annotations = {
		"self-fix-1": card("self-fix-1", { selfFix: "1", state: "working" }),
	};
	const threads = [
		thread("t-old", { running: true, updatedAt: 1 }),
		thread("t-new", {
			running: true,
			updatedAt: 5,
			context: { card: { id: "1", kind: "butler-card", name: "x" } },
		}),
		thread("t-done", { updatedAt: 9 }),
	];
	assert.equal(
		presenceOf(noButler, annotations, threads, 10).cursor?.target,
		"self-fix-1",
	);
	assert.equal(
		presenceOf(noButler, {}, [threads[0] as CommentThread], 10).cursor?.target,
		"t-old",
	);
});

test("without anything else he sits on his newest running change", () => {
	const annotations: Annotations = {
		old: card("old", { selfFix: "1", state: "working", updatedAt: 1 }),
		fresh: card("fresh", { selfFix: "2", state: "working", updatedAt: 5 }),
		finished: card("finished", { selfFix: "3", state: "done", updatedAt: 9 }),
		own: card("own", { state: "working", updatedAt: 9 }),
	};
	assert.deepEqual(presenceOf(noButler, annotations, [], 10), {
		face: { target: "fresh", label: "Butler (change)" },
		cursor: { target: "fresh", label: "Butler (change)" },
		following: false,
	});
	assert.deepEqual(presenceOf(noButler, {}, [], 10), {
		face: null,
		cursor: null,
		following: false,
	});
});
