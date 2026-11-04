import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountUsage, LastRuns } from "../shared/types.ts";
import { accountDefault, runsOnDefault } from "./lastRuns.ts";

const runs: LastRuns = {
	"/dev/kanban": { runsOn: "cloud" },
	"/dev/hkjc": { runsOn: "runner_pilot", account: 2 },
};

const accounts = [{ number: 1 }, { number: 2 }] as AccountUsage[];

describe("runsOnDefault", () => {
	it("starts where the project last ran, else in the cloud", () => {
		assert.equal(runsOnDefault(runs, "/dev/hkjc"), "runner_pilot");
		assert.equal(runsOnDefault(runs, "/dev/kanban"), "cloud");
		assert.equal(runsOnDefault(runs, "/dev/new"), "cloud");
	});
});

describe("accountDefault", () => {
	it("uses the project's last account while it still exists", () => {
		assert.equal(accountDefault(runs, "/dev/hkjc", accounts), 2);
		assert.equal(accountDefault(runs, "/dev/kanban", accounts), undefined);
		assert.equal(
			accountDefault(runs, "/dev/hkjc", [{ number: 1 }] as AccountUsage[]),
			undefined,
		);
		assert.equal(accountDefault(runs, "/dev/hkjc", null), undefined);
	});
});
