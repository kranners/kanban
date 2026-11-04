import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LastRuns } from "../shared/types.ts";
import {
	createLastRunStore,
	loadLastRuns,
	maxLastRuns,
	parseLastRuns,
} from "./lastRuns.ts";

describe("parseLastRuns", () => {
	it("keeps valid runs and drops the rest", () => {
		assert.deepEqual(
			parseLastRuns({
				"/dev/kanban": { runsOn: "cloud" },
				"/dev/hkjc": { runsOn: "runner_pilot", account: 2 },
				"/dev/butler": { runsOn: "env_01abc", account: 0 },
				"/dev/bad": { runsOn: "moon" },
				relative: { runsOn: "local" },
				"/dev/none": null,
			}),
			{
				"/dev/kanban": { runsOn: "cloud" },
				"/dev/hkjc": { runsOn: "runner_pilot", account: 2 },
				"/dev/butler": { runsOn: "env_01abc" },
			},
		);
		assert.deepEqual(parseLastRuns("nope"), {});
	});
});

describe("createLastRunStore", () => {
	const setup = async (initial: LastRuns = {}) => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-last-runs-"));
		const file = join(dir, "state", "last-runs.json");
		const changes: LastRuns[] = [];
		const store = createLastRunStore({
			file,
			initial,
			onChange: (runs) => changes.push(runs),
		});
		return { file, store, changes };
	};

	it("remembers each project's latest run and saves it", async () => {
		const { file, store, changes } = await setup();
		store.record("/dev/hkjc", { runsOn: "runner_pilot", account: 2 });
		store.record("/dev/kanban", { runsOn: "cloud" });
		store.record("/dev/hkjc", { runsOn: "local" });
		await store.saved();
		const expected = {
			"/dev/kanban": { runsOn: "cloud" },
			"/dev/hkjc": { runsOn: "local" },
		};
		assert.deepEqual(store.current(), expected);
		assert.equal(changes.length, 3);
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), expected);
		assert.deepEqual(await loadLastRuns(file), expected);
	});

	it("doesn't announce a run that changes nothing", async () => {
		const { store, changes } = await setup({
			"/dev/hkjc": { runsOn: "runner_pilot", account: 2 },
		});
		store.record("/dev/hkjc", { runsOn: "runner_pilot", account: 2 });
		assert.equal(changes.length, 0);
		store.record("/dev/hkjc", { runsOn: "runner_pilot" });
		assert.deepEqual(changes, [{ "/dev/hkjc": { runsOn: "runner_pilot" } }]);
	});

	it("forgets the least recently run projects past the cap", async () => {
		const { store } = await setup();
		for (let index = 0; index <= maxLastRuns; index += 1)
			store.record(`/dev/p${index}`, { runsOn: "cloud" });
		const cwds = Object.keys(store.current());
		assert.equal(cwds.length, maxLastRuns);
		assert.ok(!cwds.includes("/dev/p0"));
		assert.equal(cwds.at(-1), `/dev/p${maxLastRuns}`);
	});
});
