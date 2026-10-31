import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	healthzUrl,
	isLockStale,
	lockStaleMs,
	needsDeps,
	needsRestart,
	planSync,
	type SyncFacts,
} from "./sync.ts";

const facts = (over: Partial<SyncFacts> = {}): SyncFacts => ({
	branch: "main",
	dirty: false,
	headIsAncestor: true,
	headSha: "aaaaaaa1",
	originSha: "bbbbbbb2",
	stampSha: "aaaaaaa1",
	failedSha: null,
	disabled: false,
	...over,
});

describe("planSync", () => {
	it("updates when origin moved", () => {
		assert.equal(planSync(facts()), "update");
	});

	it("skips when built and current", () => {
		assert.equal(
			planSync(facts({ headSha: "b", originSha: "b", stampSha: "b" })),
			"skip:up to date",
		);
	});

	it("rebuilds a checkout pulled by hand or with no stamp", () => {
		assert.equal(
			planSync(facts({ headSha: "b", originSha: "b", stampSha: "a" })),
			"update",
		);
		assert.equal(
			planSync(facts({ headSha: "b", originSha: "b", stampSha: null })),
			"update",
		);
	});

	it("skips when disabled, before anything else", () => {
		assert.equal(
			planSync(facts({ disabled: true, branch: "x", dirty: true })),
			"skip:disabled",
		);
	});

	it("refuses off main, dirty or ahead", () => {
		assert.match(planSync(facts({ branch: "feature" })), /^refuse:on feature/);
		assert.match(planSync(facts({ branch: "" })), /^refuse:on a detached HEAD/);
		assert.match(planSync(facts({ dirty: true })), /^refuse:tracked files/);
		assert.match(
			planSync(facts({ headIsAncestor: false })),
			/^refuse:local commits.*npm run land/,
		);
	});

	it("does not retry a failed build until origin moves", () => {
		assert.match(
			planSync(facts({ failedSha: "bbbbbbb2" })),
			/^skip:build failed/,
		);
		assert.equal(planSync(facts({ failedSha: "ccccccc3" })), "update");
	});
});

describe("needsDeps", () => {
	it("is true only for package files", () => {
		assert.equal(needsDeps(["package-lock.json"]), true);
		assert.equal(needsDeps(["package.json", "src/web/App.tsx"]), true);
		assert.equal(needsDeps(["src/server/http.ts"]), false);
		assert.equal(needsDeps([]), false);
	});
});

describe("needsRestart", () => {
	it("skips the restart for page, docs and markdown changes", () => {
		assert.equal(
			needsRestart([
				"src/web/App.tsx",
				"src/web/styles.css",
				"src/web/stickers/1f600.svg",
				"docs/design.md",
				"site/index.html",
				"README.md",
				".github/workflows/check.yml",
			]),
			false,
		);
		assert.equal(needsRestart([]), false);
	});

	it("restarts for server, shared, script and package changes", () => {
		assert.equal(needsRestart(["src/server/http.ts"]), true);
		assert.equal(needsRestart(["src/shared/colours.ts"]), true);
		assert.equal(needsRestart(["scripts/sync.ts"]), true);
		assert.equal(needsRestart(["package-lock.json"]), true);
	});

	it("restarts for src/web modules the server imports", () => {
		assert.equal(needsRestart(["src/web/placement.ts"]), true);
		assert.equal(needsRestart(["src/web/stickers/manifest.ts"]), true);
		assert.equal(needsRestart(["src/web/App.tsx", "src/web/grid.ts"]), true);
	});
});

describe("healthzUrl", () => {
	it("targets the agent's host and port", () => {
		assert.equal(healthzUrl({}), "http://127.0.0.1:7420/healthz");
		assert.equal(
			healthzUrl({ KANBAN_PORT: "7500", KANBAN_HOST: "0.0.0.0" }),
			"http://127.0.0.1:7500/healthz",
		);
		assert.equal(
			healthzUrl({ KANBAN_HOST: "::1" }),
			"http://[::1]:7420/healthz",
		);
	});
});

describe("isLockStale", () => {
	it("is stale when the holder is dead or the lock is old", () => {
		assert.equal(isLockStale({ pidAlive: true, ageMs: 1000 }), false);
		assert.equal(isLockStale({ pidAlive: false, ageMs: 1000 }), true);
		assert.equal(isLockStale({ pidAlive: true, ageMs: lockStaleMs + 1 }), true);
	});
});
