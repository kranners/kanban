import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Annotations, DocIndex, DocStore } from "../shared/types.ts";
import { docShelf, shelfFileCount } from "./docShelf.ts";

const store = (id: string, title: string): DocStore => ({
	kind: "docs",
	id,
	title,
	x: 0,
	y: 0,
	w: 200,
	h: 160,
	z: 0,
});

const annotations: Annotations = {
	b: store("b", "Runbooks"),
	a: store("a", "Architecture"),
	n: {
		kind: "note",
		id: "n",
		text: "not a store",
		color: "yellow",
		x: 0,
		y: 0,
		w: 100,
		h: 100,
		z: 0,
	},
};

const index: DocIndex = {
	a: [
		{ path: "index.md", size: 1, updatedAt: 1 },
		{ path: "api/auth.md", size: 1, updatedAt: 2 },
	],
	b: [{ path: "deploy.md", size: 1, updatedAt: 3 }],
};

const titles = (query: string) =>
	docShelf(annotations, index, query).map((entry) => [
		entry.store.title,
		entry.files.map((file) => file.path),
	]);

describe("docShelf", () => {
	it("lists every doc store by title with all its files", () => {
		assert.deepEqual(titles(""), [
			["Architecture", ["index.md", "api/auth.md"]],
			["Runbooks", ["deploy.md"]],
		]);
	});

	it("keeps every file of a store whose title matches", () => {
		assert.deepEqual(titles(" run"), [["Runbooks", ["deploy.md"]]]);
	});

	it("narrows to matching files, ignoring case", () => {
		assert.deepEqual(titles("AUTH"), [["Architecture", ["api/auth.md"]]]);
	});

	it("drops stores with nothing matching", () => {
		assert.deepEqual(titles("nothing"), []);
	});

	it("lists a store with no index entry as empty", () => {
		assert.deepEqual(
			docShelf(annotations, {}, "").map((entry) => entry.files.length),
			[0, 0],
		);
	});

	it("counts files across entries", () => {
		assert.equal(shelfFileCount(docShelf(annotations, index, "")), 3);
	});
});
