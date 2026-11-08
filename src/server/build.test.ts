import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildIdReader } from "./build.ts";

test("reads the page's build id, again once the build replaces it", async () => {
	const dist = await mkdtemp(join(tmpdir(), "kanban-build-"));
	try {
		const read = buildIdReader(dist);
		assert.equal(read(), null, "no build yet");
		await writeFile(join(dist, "build-id"), "one-1\n");
		assert.equal(read(), "one-1");
		await writeFile(join(dist, "build-id"), "two-2\n");
		await utimes(
			join(dist, "build-id"),
			new Date(),
			new Date(Date.now() + 5000),
		);
		assert.equal(read(), "two-2");
		await writeFile(join(dist, "build-id"), "not a build id!\n");
		await utimes(
			join(dist, "build-id"),
			new Date(),
			new Date(Date.now() + 9000),
		);
		assert.equal(read(), null, "anything else is no build");
	} finally {
		await rm(dist, { recursive: true, force: true });
	}
});
