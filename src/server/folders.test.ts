import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderPickOf, withoutTrailingSlash } from "./folders.ts";

describe("folder picker", () => {
	it("returns the chosen folder without its trailing slash", () => {
		assert.deepEqual(folderPickOf(null, "/Users/me/dev/kanban/\n", ""), {
			ok: true,
			path: "/Users/me/dev/kanban",
		});
	});

	it("keeps the root folder", () => {
		assert.equal(withoutTrailingSlash("/"), "/");
	});

	it("reports a cancelled dialog apart from a failure", () => {
		const failed = new Error("Command failed");
		assert.deepEqual(
			folderPickOf(
				failed,
				"",
				"0:83: execution error: User canceled. (-128)\n",
			),
			{ ok: false, cancelled: true },
		);
		assert.deepEqual(
			folderPickOf(
				failed,
				"",
				"execution error: No user interaction allowed. (-1713)\n",
			),
			{
				ok: false,
				error: "execution error: No user interaction allowed. (-1713)",
			},
		);
	});
});
