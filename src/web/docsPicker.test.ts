import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Annotations, DocStore } from "../shared/types.ts";
import {
	docStoreChoices,
	docsLabel,
	pickedStores,
	toggledStore,
} from "./docsPicker.ts";

const store = (id: string, title: string): DocStore => ({
	kind: "docs",
	id,
	title,
	x: 0,
	y: 0,
	w: 288,
	h: 216,
	z: 1,
});

const annotations: Annotations = {
	b: store("b", "Runbook"),
	n: {
		kind: "note",
		id: "n",
		text: "hi",
		color: "yellow",
		x: 0,
		y: 0,
		w: 1,
		h: 1,
		z: 1,
	},
	a: store("a", "API"),
	c: store("c", "API"),
	s: {
		kind: "sticker",
		id: "s",
		sticker: "star",
		x: 0,
		y: 0,
		w: 1,
		h: 1,
		z: 1,
	},
};

describe("docs picker", () => {
	const choices = docStoreChoices(annotations);

	it("offers only doc stores, sorted by title then id", () => {
		assert.deepEqual(
			choices.map(({ id }) => id),
			["a", "c", "b"],
		);
		assert.deepEqual(docStoreChoices({}), []);
	});

	it("labels the trigger by what is picked", () => {
		assert.equal(docsLabel([], choices), "No docs");
		assert.equal(docsLabel(["b"], choices), "Runbook");
		assert.equal(docsLabel(["a", "b"], choices), "2 doc stores");
		assert.equal(docsLabel(["gone"], choices), "No docs");
		assert.equal(docsLabel(["gone", "b"], choices), "Runbook");
	});

	it("toggles a store in and out of the pick", () => {
		assert.deepEqual(toggledStore([], "a", choices), ["a"]);
		assert.deepEqual(toggledStore(["a"], "b", choices), ["a", "b"]);
		assert.deepEqual(toggledStore(["a", "b"], "a", choices), ["b"]);
	});

	it("drops picked stores that have gone from the board", () => {
		assert.deepEqual(pickedStores(["gone", "b"], choices), ["b"]);
		assert.deepEqual(toggledStore(["gone"], "a", choices), ["a"]);
	});
});
