import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	docContentType,
	docFileUrl,
	extensionOf,
	isDocPath,
	isImagePath,
	isMarkdownPath,
	isTextPath,
	resolveDocPath,
} from "./docPaths.ts";

describe("isDocPath", () => {
	it("takes nested markdown, text and image files", () => {
		for (const path of [
			"index.md",
			"guides/setup.md",
			"assets/flow-v2.PNG",
			"data/runs.csv",
			"_drafts/idea.txt",
		]) {
			assert.equal(isDocPath(path), true, path);
		}
	});

	it("refuses escapes, hidden files, odd characters and unknown types", () => {
		for (const path of [
			"",
			"/index.md",
			"../index.md",
			"guides/../index.md",
			"guides//setup.md",
			".env.md",
			"guides/.hidden/a.md",
			"has space.md",
			"page.html",
			"script.js",
			"README",
			"a/b/c/d/e/f/g/h/i.md",
			`${"a".repeat(101)}.md`,
		]) {
			assert.equal(isDocPath(path), false, path);
		}
	});
});

describe("doc file kinds", () => {
	it("reads the type from the extension", () => {
		assert.equal(extensionOf("guides/Setup.MD"), ".md");
		assert.equal(extensionOf("guides.v2/setup"), "");
		assert.equal(docContentType("a/b.png"), "image/png");
		assert.equal(docContentType("a/b.jpeg"), "image/jpeg");
		assert.equal(docContentType("notes.md"), "text/markdown; charset=utf-8");
		assert.equal(isMarkdownPath("notes.md"), true);
		assert.equal(isImagePath("flow.svg"), true);
		assert.equal(isImagePath("notes.md"), false);
		assert.equal(isTextPath("flow.svg"), true);
		assert.equal(isTextPath("shot.png"), false);
	});
});

describe("resolveDocPath", () => {
	it("resolves links relative to the page that holds them", () => {
		assert.equal(
			resolveDocPath("guides/setup.md", "auth.md"),
			"guides/auth.md",
		);
		assert.equal(
			resolveDocPath("guides/setup.md", "./auth.md#tokens"),
			"guides/auth.md",
		);
		assert.equal(
			resolveDocPath("guides/setup.md", "../assets/flow.png"),
			"assets/flow.png",
		);
		assert.equal(resolveDocPath("guides/setup.md", "/index.md"), "index.md");
		assert.equal(
			resolveDocPath("index.md", "guides/setup.md?x=1"),
			"guides/setup.md",
		);
	});

	it("leaves external links, anchors and escapes alone", () => {
		assert.equal(resolveDocPath("index.md", "https://example.com/a.md"), null);
		assert.equal(resolveDocPath("index.md", "mailto:me@example.com"), null);
		assert.equal(resolveDocPath("index.md", "//example.com/a.md"), null);
		assert.equal(resolveDocPath("index.md", "#usage"), null);
		assert.equal(resolveDocPath("index.md", "../outside.md"), null);
		assert.equal(resolveDocPath("index.md", "page.html"), null);
	});
});

describe("docFileUrl", () => {
	it("points at the board's file route, versioned when asked", () => {
		assert.equal(
			docFileUrl("store-1", "guides/setup.md"),
			"/api/docs/store-1/files/guides/setup.md",
		);
		assert.equal(
			docFileUrl("store-1", "assets/flow.png", 1700000000000),
			"/api/docs/store-1/files/assets/flow.png?v=1700000000000",
		);
	});
});
