import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocFile, DocIndex, DocStore } from "../shared/types.ts";
import {
	docShelf,
	pagePathProblem,
	shelfFileCount,
	titleProblem,
	withFile,
	withoutFile,
	withoutStore,
	withStore,
} from "./docShelf.ts";

const store = (id: string, title: string): DocStore => ({
	id,
	title,
	createdAt: 0,
	updatedAt: 0,
});

const stores: DocStore[] = [store("b", "runbooks"), store("a", "Architecture")];

const file = (path: string, updatedAt = 1): DocFile => ({
	path,
	size: 1,
	updatedAt,
});

const index: DocIndex = {
	a: [file("index.md"), file("api/auth.md", 2)],
	b: [file("deploy.md", 3)],
};

const titles = (query: string) =>
	docShelf(stores, index, query).map((entry) => [
		entry.store.title,
		entry.files.map((file) => file.path),
	]);

describe("docShelf", () => {
	it("lists every doc store by title, ignoring case, with all its files", () => {
		assert.deepEqual(titles(""), [
			["Architecture", ["index.md", "api/auth.md"]],
			["runbooks", ["deploy.md"]],
		]);
	});

	it("keeps every file of a store whose title matches", () => {
		assert.deepEqual(titles(" RUN"), [["runbooks", ["deploy.md"]]]);
	});

	it("narrows to matching files, ignoring case", () => {
		assert.deepEqual(titles("AUTH"), [["Architecture", ["api/auth.md"]]]);
	});

	it("drops stores with nothing matching", () => {
		assert.deepEqual(titles("nothing"), []);
	});

	it("lists a store with no index entry as empty", () => {
		assert.deepEqual(
			docShelf(stores, {}, "").map((entry) => entry.files.length),
			[0, 0],
		);
	});

	it("counts files across entries", () => {
		assert.equal(shelfFileCount(docShelf(stores, index, "")), 3);
	});
});

describe("doc store titles", () => {
	it("accepts one line of up to 60 characters", () => {
		assert.equal(titleProblem("  Runbooks "), null);
		assert.equal(titleProblem("x".repeat(60)), null);
	});

	it("refuses blank, long and multi-line titles", () => {
		assert.match(titleProblem("   ") ?? "", /title/);
		assert.match(titleProblem("x".repeat(61)) ?? "", /60 characters/);
		assert.match(titleProblem("a\nb") ?? "", /one line/);
	});
});

describe("new page paths", () => {
	const files = [file("index.md")];

	it("accepts text paths in folders", () => {
		assert.equal(pagePathProblem("notes/setup.md", files), null);
		assert.equal(pagePathProblem(" data.json ", files), null);
	});

	it("refuses empty, invalid, binary and existing paths", () => {
		assert.match(pagePathProblem("", files) ?? "", /Name the page/);
		assert.match(pagePathProblem("../x.md", files) ?? "", /letters/);
		assert.match(pagePathProblem("notes/setup", files) ?? "", /letters/);
		assert.match(pagePathProblem("diagram.png", files) ?? "", /text/);
		assert.match(pagePathProblem("index.md", files) ?? "", /already exists/);
	});
});

describe("local doc updates", () => {
	it("adds or replaces a store, keeping title order", () => {
		const added = withStore(stores, store("c", "Billing"));
		assert.deepEqual(
			added.map((s) => s.id),
			["a", "c", "b"],
		);
		const renamed = withStore(added, store("b", "Alpha"));
		assert.deepEqual(
			renamed.map((s) => s.title),
			["Alpha", "Architecture", "Billing"],
		);
		assert.deepEqual(
			withoutStore(renamed, "b").map((s) => s.id),
			["a", "c"],
		);
	});

	it("writes and removes files in one store", () => {
		const written = withFile(index, "b", file("deploy.md", 9));
		assert.deepEqual(written.b, [file("deploy.md", 9)]);
		assert.equal(written.a, index.a);
		assert.deepEqual(withFile({}, "c", file("x.md")).c, [file("x.md")]);
		assert.deepEqual(withoutFile(index, "a", "index.md").a, [
			file("api/auth.md", 2),
		]);
		assert.equal(withoutFile(index, "missing", "x.md"), index);
	});
});
