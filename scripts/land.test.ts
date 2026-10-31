import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNonFastForward, parseConflicts, shouldSyncHere } from "./land.ts";

describe("isNonFastForward", () => {
	it("matches git's rejections when main moved", () => {
		assert.equal(
			isNonFastForward(
				"To github.com:me/kanban.git\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to 'github.com:me/kanban.git'\nhint: Updates were rejected because the remote contains work that you do not\n",
			),
			true,
		);
		assert.equal(
			isNonFastForward(
				" ! [rejected]        HEAD -> main (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch is behind\n",
			),
			true,
		);
	});

	it("matches a push that lost the race to update main", () => {
		assert.equal(
			isNonFastForward(
				" ! [remote rejected] HEAD -> main (incorrect old value provided)\nerror: failed to push some refs\n",
			),
			true,
		);
		assert.equal(
			isNonFastForward(
				"remote: error: cannot lock ref 'refs/heads/main': is at 1111111 but expected 2222222\n",
			),
			true,
		);
	});

	it("does not retry auth, network or hook failures", () => {
		assert.equal(
			isNonFastForward(
				"remote: Permission to me/kanban.git denied to bot.\nfatal: unable to access 'https://github.com/me/kanban.git/': The requested URL returned error: 403\n",
			),
			false,
		);
		assert.equal(
			isNonFastForward(
				"fatal: unable to access 'https://github.com/me/kanban.git/': Could not resolve host: github.com\n",
			),
			false,
		);
		assert.equal(
			isNonFastForward(
				" ! [remote rejected] HEAD -> main (protected branch hook declined)\n",
			),
			false,
		);
	});
});

describe("parseConflicts", () => {
	it("lists conflicted files", () => {
		assert.deepEqual(parseConflicts("src/web/App.tsx\n CLAUDE.md \n\n"), [
			"src/web/App.tsx",
			"CLAUDE.md",
		]);
		assert.deepEqual(parseConflicts(""), []);
	});
});

describe("shouldSyncHere", () => {
	it("syncs only on a Mac whose main checkout is on main", () => {
		assert.equal(
			shouldSyncHere({ platform: "darwin", mainBranch: "main" }),
			true,
		);
		assert.equal(
			shouldSyncHere({ platform: "linux", mainBranch: "main" }),
			false,
		);
		assert.equal(
			shouldSyncHere({ platform: "darwin", mainBranch: "feature" }),
			false,
		);
		assert.equal(shouldSyncHere({ platform: "darwin", mainBranch: "" }), false);
	});
});
