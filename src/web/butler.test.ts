import assert from "node:assert/strict";
import { test } from "node:test";
import type { Annotations, ButlerCard } from "../shared/types.ts";
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

test("Butler's cursor stays where he last acted for two minutes", () => {
	const presence = {
		presence: { target: "s1", label: "Butler", at: 1000 },
		watching: [],
	};
	assert.deepEqual(presenceOf(presence, {}, 1000 + 60_000), {
		target: "s1",
		label: "Butler",
	});
	assert.equal(presenceOf(presence, {}, 1000 + 121_000), null);
});

test("on a self-fix card his cursor says so", () => {
	const annotations: Annotations = {
		f: card("f", { selfFix: "20261103-014125-2712401" }),
	};
	const presence = {
		presence: { target: "f", label: "Butler", at: 0 },
		watching: [],
	};
	assert.deepEqual(presenceOf(presence, annotations, 10), {
		target: "f",
		label: "Butler (change)",
	});
});

test("without a recent action he sits on his newest running self-fix", () => {
	const annotations: Annotations = {
		old: card("old", { selfFix: "1", state: "working", updatedAt: 1 }),
		fresh: card("fresh", { selfFix: "2", state: "working", updatedAt: 5 }),
		finished: card("finished", { selfFix: "3", state: "done", updatedAt: 9 }),
		own: card("own", { state: "working", updatedAt: 9 }),
	};
	assert.deepEqual(
		presenceOf({ presence: null, watching: [] }, annotations, 10),
		{ target: "fresh", label: "Butler (change)" },
	);
	assert.equal(presenceOf({ presence: null, watching: [] }, {}, 10), null);
});
