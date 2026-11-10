import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunnerSignals } from "../shared/runners.ts";
import {
	createDropRecorder,
	dropFile,
	parseDropStore,
	recentDrops,
} from "./runnerDrops.ts";

const hour = 3_600_000;
const signals: RunnerSignals = {
	power: "battery",
	batteryPercent: 40,
	lidOpen: false,
	thermal: "nominal",
	idleSeconds: 900,
	sleepMinutes: 1,
	checkouts: [],
	allow: { classes: [], ceilings: {} },
	why: {},
};

describe("createDropRecorder", () => {
	const utcHour = (at: number) => new Date(at).getUTCHours();

	it("counts drops by hour and closes each as same boot or a reboot", () => {
		const drops = createDropRecorder({ hourOf: utcHour });
		drops.seen("laptop", 0);
		drops.gone("laptop", 2 * hour, 1_000, signals);
		assert.equal(drops.back("laptop", 3 * hour, 1_000 + 60_000), true);
		drops.gone("laptop", 2 * hour + 24 * hour, 1_000, undefined);
		assert.equal(drops.back("laptop", 27 * hour, 9 * hour), true);
		drops.gone("laptop", 13 * hour, 9 * hour, signals);
		const record = drops.records().laptop;
		assert.ok(record);
		assert.equal(record.total, 3);
		assert.equal(record.byHour[2], 2);
		assert.equal(record.byHour[13], 1);
		assert.deepEqual(
			record.recent.map((drop) => [drop.hour, drop.cause, drop.lidOpen]),
			[
				[13, null, false],
				[2, "rebooted", null],
				[2, "same-boot", false],
			],
		);
		assert.equal(record.recent[2]?.power, "battery");
	});

	it("has nothing to close for a machine that never dropped", () => {
		const drops = createDropRecorder();
		assert.equal(drops.back("laptop", 1, 1), false);
		drops.seen("laptop", 5);
		assert.equal(drops.records().laptop?.total, 0);
	});

	it("keeps only the latest drops in full, but counts them all", () => {
		const drops = createDropRecorder({ hourOf: utcHour });
		for (let i = 0; i < recentDrops + 5; i++) {
			drops.gone("laptop", i * hour, 0, undefined);
			drops.back("laptop", i * hour + 1, 0);
		}
		const record = drops.records().laptop;
		assert.equal(record?.recent.length, recentDrops);
		assert.equal(record?.total, recentDrops + 5);
	});

	it("survives a hub restart through its file, and reads junk as empty", async () => {
		const file = join(await mkdtemp(join(tmpdir(), "drops-")), "drops.json");
		const first = createDropRecorder({ ...dropFile(file), hourOf: utcHour });
		first.gone("laptop", 4 * hour, 0, signals);
		const second = createDropRecorder({ ...dropFile(file), hourOf: utcHour });
		assert.equal(second.back("laptop", 5 * hour, 0), true);
		assert.equal(second.records().laptop?.recent[0]?.cause, "same-boot");
		assert.deepEqual(parseDropStore("nope"), {});
		assert.deepEqual(parseDropStore(JSON.stringify({ x: { since: 1 } })), {});
	});
});
