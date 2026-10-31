import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocFile } from "../shared/types.ts";
import {
	anchorId,
	createSlugger,
	type DocNode,
	docHome,
	docPreview,
	docTree,
	fragmentOf,
	lastUpdated,
} from "./docTree.ts";

const files = (...paths: string[]): DocFile[] =>
	paths.map((path, index) => ({ path, size: 10, updatedAt: 1000 + index }));

const outline = (nodes: DocNode[]): unknown[] =>
	nodes.map((node) =>
		node.kind === "folder"
			? { [node.name]: outline(node.children) }
			: node.name,
	);

describe("docTree", () => {
	it("puts folders before files, sorted case-insensitively", () => {
		assert.deepEqual(
			outline(
				docTree(files("b.md", "Zeta/x.md", "A.md", "alpha/y.md", "c.md")),
			),
			[{ alpha: ["y.md"] }, { Zeta: ["x.md"] }, "A.md", "b.md", "c.md"],
		);
	});

	it("nests paths and counts every file under a folder", () => {
		const tree = docTree(
			files("guides/setup.md", "guides/deep/one.md", "guides/deep/two.png"),
		);
		assert.deepEqual(outline(tree), [
			{ guides: [{ deep: ["one.md", "two.png"] }, "setup.md"] },
		]);
		const [guides] = tree;
		assert.equal(guides?.kind === "folder" && guides.count, 3);
		assert.equal(guides?.kind === "folder" && guides.path, "guides");
		const deep = guides?.kind === "folder" ? guides.children[0] : undefined;
		assert.equal(deep?.kind === "folder" && deep.path, "guides/deep");
		assert.equal(deep?.kind === "folder" && deep.count, 2);
	});

	it("keeps the file record on each leaf", () => {
		const [leaf] = docTree(files("index.md"));
		assert.deepEqual(leaf, {
			kind: "file",
			name: "index.md",
			file: { path: "index.md", size: 10, updatedAt: 1000 },
		});
	});
});

describe("docPreview", () => {
	it("summarises top-level folders with counts, then files", () => {
		assert.deepEqual(
			docPreview(files("index.md", "guides/a.md", "guides/b/c.md", "x.png")),
			{
				rows: [
					{ kind: "folder", name: "guides", count: 2 },
					{ kind: "file", name: "index.md" },
					{ kind: "file", name: "x.png" },
				],
				more: 0,
			},
		);
	});

	it("shows at most six rows, the last one saying how many more", () => {
		const preview = docPreview(
			files("a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md"),
		);
		assert.equal(preview.rows.length, 5);
		assert.equal(preview.more, 3);
		assert.equal(
			docPreview(files("a.md", "b.md", "c.md", "d.md", "e.md", "f.md")).more,
			0,
		);
	});

	it("finds the latest update", () => {
		assert.equal(lastUpdated([]), null);
		assert.equal(lastUpdated(files("a.md", "b.md", "c.md")), 1002);
	});
});

describe("docHome", () => {
	it("prefers index.md, then README.md, then the first page, then any file", () => {
		assert.equal(docHome(files("a.md", "README.md", "index.md")), "index.md");
		assert.equal(
			docHome(files("a.md", "readme.MD", "g/index.md")),
			"readme.MD",
		);
		assert.equal(docHome(files("x.png", "g/index.md", "b.md")), "g/index.md");
		assert.equal(docHome(files("x.png", "y.txt")), "x.png");
		assert.equal(docHome([]), null);
	});
});

describe("headings", () => {
	it("gives doc- ids and suffixes duplicates", () => {
		const slug = createSlugger();
		assert.equal(slug("Getting Started!"), "doc-getting-started");
		assert.equal(slug("Getting started"), "doc-getting-started-1");
		assert.equal(slug("Getting started"), "doc-getting-started-2");
		assert.equal(slug("API: v2_beta"), "doc-api-v2_beta");
		assert.equal(createSlugger()("Getting started"), "doc-getting-started");
	});

	it("maps a link fragment to its heading id", () => {
		assert.equal(anchorId("getting-started"), "doc-getting-started");
		assert.equal(anchorId("Caf%C3%A9"), "doc-café");
		assert.equal(anchorId("%E0%A4%A"), "doc-e0a4a");
		assert.equal(fragmentOf("guide.md#setup"), "setup");
		assert.equal(fragmentOf("guide.md#"), null);
		assert.equal(fragmentOf("guide.md"), null);
	});
});
