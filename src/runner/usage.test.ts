import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	availableFromMeminfo,
	availableFromVmStat,
	busyPercent,
	createUsageSampler,
	parsePs,
	processStats,
} from "./usage.ts";

describe("busyPercent", () => {
	it("is the busy share of the time between two readings", () => {
		assert.equal(
			busyPercent({ idle: 100, total: 200 }, { idle: 150, total: 400 }),
			75,
		);
		assert.equal(
			busyPercent({ idle: 1, total: 2 }, { idle: 1, total: 2 }),
			null,
		);
	});
});

describe("memory readings", () => {
	it("reads MemAvailable from /proc/meminfo", () => {
		assert.equal(
			availableFromMeminfo(
				"MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    8000000 kB\n",
			),
			8_000_000 * 1024,
		);
		assert.equal(availableFromMeminfo("MemTotal: 1 kB\n"), null);
	});

	it("adds up the reusable pages from vm_stat", () => {
		const text = [
			"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
			"Pages free:                               1000.",
			"Pages active:                             9999.",
			"Pages inactive:                           2000.",
			"Pages speculative:                         300.",
			"Pages purgeable:                            50.",
		].join("\n");
		assert.equal(availableFromVmStat(text), 3350 * 16384);
		assert.equal(availableFromVmStat("nothing"), null);
	});
});

describe("parsePs", () => {
	it("reads pid, cpu and rss in kilobytes", () => {
		const stats = parsePs("  123  12.5  2048\n 456 0.0 10\nbogus line\n");
		assert.deepEqual(stats.get(123), { cpuPercent: 12.5, rss: 2048 * 1024 });
		assert.deepEqual(stats.get(456), { cpuPercent: 0, rss: 10 * 1024 });
		assert.equal(stats.size, 2);
	});
});

describe("createUsageSampler", () => {
	it("reports this machine's cores, memory and disk", async () => {
		const sample = createUsageSampler();
		const usage = await sample();
		assert.ok(usage.cpus >= 1);
		assert.ok(usage.memTotal > 0);
		assert.ok(usage.memUsed >= 0 && usage.memUsed <= usage.memTotal);
		assert.ok(usage.diskFree === null || usage.diskFree >= 0);
		const again = await sample();
		assert.ok(
			again.cpuPercent === null ||
				(again.cpuPercent >= 0 && again.cpuPercent <= 100),
		);
	});

	it("reads this process with ps, and nothing on Windows", async () => {
		const stats = await processStats([process.pid]);
		if (process.platform !== "win32") {
			assert.ok((stats.get(process.pid)?.rss ?? 0) > 0);
		}
		assert.equal((await processStats([process.pid], "win32")).size, 0);
	});
});
