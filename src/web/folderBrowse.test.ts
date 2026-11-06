import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	browseTarget,
	checksFolder,
	childPath,
	readBrowse,
} from "./folderBrowse.ts";

const listing = {
	machine: "pilot",
	path: "/Users/aaron/workspace",
	home: "/Users/aaron",
	parent: "/Users/aaron",
	folders: ["kanban"],
	truncated: false,
};

describe("folder browsing", () => {
	it("reads a runner's folders on the runner, everything else on the board", () => {
		assert.equal(browseTarget("runner_pilot"), "runner_pilot");
		assert.equal(browseTarget("local"), "local");
		assert.equal(browseTarget("cloud"), "local");
		assert.equal(browseTarget("env_abc"), "local");
	});

	it("checks folders up front only where they must exist", () => {
		assert.equal(checksFolder("local"), true);
		assert.equal(checksFolder("runner_pilot"), true);
		assert.equal(checksFolder("cloud"), false);
		assert.equal(checksFolder("env_abc"), false);
	});

	it("joins a subfolder with the folder's own separator", () => {
		assert.equal(childPath("/Users/aaron", "dev"), "/Users/aaron/dev");
		assert.equal(childPath("/", "home"), "/home");
		assert.equal(childPath("C:\\Users\\aaron", "dev"), "C:\\Users\\aaron\\dev");
		assert.equal(childPath("C:\\", "Users"), "C:\\Users");
	});

	it("reads listings and errors, and explains anything else", async () => {
		assert.deepEqual(await readBrowse(Response.json({ ok: true, listing })), {
			ok: true,
			listing,
		});
		assert.deepEqual(
			await readBrowse(
				Response.json({ ok: false, error: "pilot is asleep" }, { status: 422 }),
			),
			{ ok: false, error: "pilot is asleep" },
		);
		const missing = await readBrowse(new Response("nope", { status: 404 }));
		assert.equal(missing.ok, false);
		assert.match(!missing.ok ? missing.error : "", /can't list folders/);
		assert.deepEqual(
			await readBrowse(new Response("<html>", { status: 502 })),
			{
				ok: false,
				error: "The board server answered HTTP 502",
			},
		);
	});
});
