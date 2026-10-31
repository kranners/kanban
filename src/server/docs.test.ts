import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { maxDocBytes, maxDocFiles } from "../shared/docPaths.ts";
import type { DocIndex } from "../shared/types.ts";
import { loadDocFiles } from "./docs.ts";

const text = (value: string) => Buffer.from(value, "utf8");

const fresh = async () => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-docs-"));
	const changes: DocIndex[] = [];
	const files = await loadDocFiles({
		dir,
		onChange: (index) => changes.push(index),
	});
	return { dir, files, changes };
};

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

describe("loadDocFiles", () => {
	it("writes, reads, lists and removes a nested path", async () => {
		const { dir, files, changes } = await fresh();
		const written = await files.write("d1", "guides/setup.md", text("# Setup"));
		assert.ok(!("error" in written));
		assert.equal(written.path, "guides/setup.md");
		assert.equal(written.size, 7);
		await files.write("d1", "index.md", text("# Home"));
		assert.deepEqual(
			files.index().d1?.map((file) => file.path),
			["guides/setup.md", "index.md"],
		);
		assert.equal(
			(await files.read("d1", "guides/setup.md"))?.toString(),
			"# Setup",
		);
		assert.equal(await files.read("d1", "missing.md"), null);
		assert.equal(changes.length, 2);
		assert.equal(changes.at(-1), files.index());
		assert.equal(files.index(), files.index());

		assert.equal(await files.remove("d1", "guides/setup.md"), true);
		assert.equal(await files.remove("d1", "guides/setup.md"), false);
		assert.equal(await exists(join(dir, "d1", "guides")), false);
		assert.deepEqual(
			files.index().d1?.map((file) => file.path),
			["index.md"],
		);
		await files.remove("d1", "index.md");
		assert.deepEqual(files.index(), {});
		assert.equal(changes.length, 4);
	});

	it("refuses bad paths, oversized files and too many files", async () => {
		const { files, changes } = await fresh();
		for (const path of ["../x.md", ".hidden.md", "notes.exe", "a/../b.md"]) {
			assert.ok("error" in (await files.write("d1", path, text("x"))), path);
		}
		assert.ok("error" in (await files.write("../d1", "x.md", text("x"))));
		assert.ok(
			"error" in
				(await files.write("d1", "big.png", new Uint8Array(maxDocBytes + 1))),
		);
		for (let n = 0; n < maxDocFiles; n++) {
			await files.write("d2", `f${n}.txt`, text(""));
		}
		assert.ok("error" in (await files.write("d2", "one-more.txt", text(""))));
		assert.ok(!("error" in (await files.write("d2", "f0.txt", text("again")))));
		assert.equal(files.index().d2?.length, maxDocFiles);
		assert.equal(changes.length, maxDocFiles + 1);
	});

	it("refuses names that differ from existing ones only in case", async () => {
		const { files } = await fresh();
		await files.write("d1", "Guides/README.md", text("# Guides"));
		for (const path of ["Guides/readme.md", "guides/other.md"]) {
			const refused = await files.write("d1", path, text("x"));
			assert.ok("error" in refused, path);
			assert.match(refused.error, /clashes with Guides/);
		}
		assert.ok(
			!("error" in (await files.write("d1", "Guides/other.md", text("")))),
		);
		assert.ok(
			!("error" in (await files.write("d1", "Guides/README.md", text("")))),
		);
		assert.deepEqual(
			files.index().d1?.map((file) => file.path),
			["Guides/README.md", "Guides/other.md"],
		);
	});

	it("keeps the index across a reload and ignores temp files", async () => {
		const { dir, files } = await fresh();
		await files.write("d1", "index.md", text("# Home"));
		await files.write("d1", "assets/flow.png", new Uint8Array([1, 2, 3]));
		await writeFile(join(dir, "d1", ".index.md.123.1.tmp"), "half");
		await writeFile(join(dir, "d1", "notes.exe"), "nope");
		await mkdir(join(dir, "not a store"));
		await writeFile(join(dir, "not a store", "index.md"), "x");
		const reloaded = await loadDocFiles({ dir, onChange: () => {} });
		assert.deepEqual(reloaded.index(), files.index());
		assert.equal((await reloaded.read("d1", "assets/flow.png"))?.length, 3);
	});

	it("never follows a symlink out of the store", async () => {
		const { dir, files } = await fresh();
		await files.write("d1", "index.md", text("# Home"));
		const outside = await mkdtemp(join(tmpdir(), "kanban-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(dir, "d1", "link"));
		const reloaded = await loadDocFiles({ dir, onChange: () => {} });
		assert.deepEqual(
			reloaded.index().d1?.map((file) => file.path),
			["index.md"],
		);
		assert.equal(await reloaded.read("d1", "link/secret.txt"), null);
		assert.ok("error" in (await reloaded.write("d1", "link/x.md", text("x"))));
		assert.deepEqual(await readdir(outside), ["secret.txt"]);
	});

	it("drops a store's folder", async () => {
		const { dir, files, changes } = await fresh();
		await files.write("d1", "guides/setup.md", text("x"));
		await files.drop("d1");
		assert.deepEqual(await readdir(dir), []);
		assert.deepEqual(files.index(), {});
		assert.equal(changes.length, 2);
		await files.drop("d1");
		assert.equal(changes.length, 2);
	});
});
