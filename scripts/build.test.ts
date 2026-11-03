import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { shellVersion, swapIn } from "./build.ts";

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
