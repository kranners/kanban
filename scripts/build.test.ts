import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSheet, sheetMarker, shellVersion, swapIn } from "./build.ts";

describe("swapIn", () => {
	it("replaces the old build and leaves no staging dirs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-build-"));
		const out = join(dir, "dist");
		await mkdir(out);
		await writeFile(join(out, "app.js"), "old");
		await writeFile(join(out, ".commit"), "abc");
		await mkdir(`${out}.next`);
		await writeFile(join(`${out}.next`, "app.js"), "new");
		await swapIn(`${out}.next/`, out);
		assert.equal(await readFile(join(out, "app.js"), "utf8"), "new");
		assert.deepEqual(await readdir(out), ["app.js"]);
		assert.deepEqual(await readdir(dir), ["dist"]);
	});

	it("works when there is no build yet", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-build-"));
		const out = join(dir, "dist");
		await mkdir(`${out}.next`);
		await writeFile(join(`${out}.next`, "app.js"), "new");
		await swapIn(`${out}.next`, out);
		assert.equal(await readFile(join(out, "app.js"), "utf8"), "new");
	});
});

describe("shellVersion", () => {
	it("changes when any shell file changes", () => {
		const a = shellVersion([Buffer.from("app"), Buffer.from("css")]);
		assert.equal(a, shellVersion([Buffer.from("app"), Buffer.from("css")]));
		assert.notEqual(a, shellVersion([Buffer.from("app2"), Buffer.from("css")]));
		assert.match(a, /^[0-9a-f]{16}$/);
	});
});

describe("buildSheet", () => {
	it("writes one page with its marker once and nothing to fetch", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-sheet-"));
		const file = join(dir, "sheet.html");
		await buildSheet(file);
		const page = await readFile(file, "utf8");
		assert.equal(page.split(sheetMarker).length, 2);
		assert.equal(page.match(/<script\b/g)?.length, 2);
		assert.doesNotMatch(page, /<link\b|\ssrc=|@import/);
		for (const url of page.match(/url\([^)]*\)/g) ?? []) {
			assert.match(url, /^url\((data:|#)/);
		}
		assert.match(page, /font-family:"?Inter Variable/);
		assert.match(page, /JetBrains Mono/);
		assert.doesNotMatch(page, /localStorage|WebSocket|fetch\(/);
		assert.ok(page.length < 450_000, `${page.length} bytes`);
	});
});

describe("tokens.css", () => {
	it("holds the board's tokens and no fonts", async () => {
		const tokens = await readFile(
			new URL("../src/web/tokens.css", import.meta.url),
			"utf8",
		);
		assert.doesNotMatch(tokens, /@font-face|@import|url\(/);
		for (const name of [
			"--sans",
			"--mono",
			"--page",
			"--radius",
			"--state-needs-you",
		]) {
			assert.match(tokens, new RegExp(`${name}:`));
		}
		assert.match(tokens, /:root\[data-theme="dark"\]/);
		assert.match(tokens, /prefers-color-scheme: dark/);
	});
});
