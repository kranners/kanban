import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunnerView } from "../shared/runners.ts";
import {
	formatBytes,
	formatShare,
	localIsMac,
	localMachineLabel,
	localMachinePhrase,
	meters,
	platformName,
	recentlyGone,
	runnerBlocker,
	sessionsMeter,
	stateLabel,
} from "./runners.ts";

const placed = (id: string) => ({
	id,
	name: id,
	cwd: "/x",
	activity: "working" as const,
	cpuPercent: null,
	rss: null,
});

const view = (overrides: Partial<RunnerView> = {}): RunnerView => ({
	id: "jimbo",
	name: "jimbo",
	label: "jimbo",
	local: false,
	runsOn: "runner_jimbo",
	hostname: "jimbo",
	platform: "linux",
	state: "online",
	lastSeen: 1_000,
	goneSince: null,
	usage: {
		cpus: 8,
		cpuPercent: 42,
		load1: 3.25,
		memTotal: 16e9,
		memUsed: 12e9,
		diskTotal: 1000e9,
		diskFree: 250e9,
	},
	cap: 2,
	sessions: [placed("a")],
	...overrides,
});

describe("runner helpers", () => {
	it("names platforms", () => {
		assert.equal(platformName("darwin"), "macOS");
		assert.equal(platformName("win32"), "Windows");
		assert.equal(platformName("linux"), "Linux");
		assert.equal(platformName(null), "");
	});

	it("says why a machine can't take a session", () => {
		assert.equal(runnerBlocker(view()), null);
		assert.equal(
			runnerBlocker(view({ sessions: [placed("a"), placed("b")] })),
			"jimbo is at its cap (2 of 2)",
		);
		assert.equal(runnerBlocker(view({ state: "asleep" })), "jimbo is asleep");
		assert.equal(
			runnerBlocker(view({ state: "offline", lastSeen: null })),
			"jimbo's runner hasn't connected to the board",
		);
		assert.equal(runnerBlocker(view({ local: true, cap: 0 })), null);
	});

	it("names the board's own machine", () => {
		const mac = view({ local: true, label: "This Mac", platform: "darwin" });
		const spike = view({ local: true, label: "spike", platform: "linux" });
		assert.equal(localMachineLabel([]), "This Mac");
		assert.equal(localMachinePhrase([]), "this Mac");
		assert.equal(localIsMac([]), false);
		assert.equal(localMachineLabel([view(), mac]), "This Mac");
		assert.equal(localMachinePhrase([mac]), "this Mac");
		assert.equal(localIsMac([mac]), true);
		assert.equal(localMachineLabel([view(), spike]), "spike");
		assert.equal(localMachinePhrase([spike]), "spike");
		assert.equal(localIsMac([spike]), false);
	});

	it("labels the state with when it was last seen", () => {
		const ago = (at: number) => `${at}ms ago`;
		assert.equal(stateLabel(view(), ago), "Online");
		assert.equal(
			stateLabel(view({ state: "offline" }), ago),
			"Offline · seen 1000ms ago",
		);
		assert.equal(
			stateLabel(view({ state: "asleep", lastSeen: null }), ago),
			"Asleep · not seen yet",
		);
	});

	it("badges machines that dropped off within the hour, not sleepers", () => {
		const now = 10_000_000;
		const gone = view({ state: "offline", goneSince: now - 60_000 });
		assert.deepEqual(recentlyGone([gone], now), [gone]);
		assert.deepEqual(
			recentlyGone(
				[view({ state: "offline", goneSince: now - 2 * 3_600_000 })],
				now,
			),
			[],
		);
		assert.deepEqual(
			recentlyGone([view({ state: "asleep", goneSince: now })], now),
			[],
		);
		assert.deepEqual(
			recentlyGone([view({ state: "offline", goneSince: null })], now),
			[],
		);
	});

	it("formats bytes", () => {
		assert.equal(formatBytes(512), "512 B");
		assert.equal(formatBytes(12_345_678_901), "12.3 GB");
		assert.equal(formatBytes(250e9), "250 GB");
		assert.equal(formatShare(840e6, 16.9e9), "0.8 of 16.9 GB");
		assert.equal(formatShare(100e9, 128e9), "100 of 128 GB");
	});

	it("turns usage and allocation into meters", () => {
		assert.deepEqual(meters(view()), {
			cpu: { percent: 42, value: "42%", extra: "load 3.3 · 8 cores" },
			memory: { percent: 75, value: "75%", extra: "12.0 of 16.0 GB" },
			disk: { percent: 75, value: "75%", extra: "250 GB free" },
		});
		assert.equal(meters(view({ usage: null })), null);
		const windows = meters(
			view({
				usage: {
					cpus: 4,
					cpuPercent: null,
					load1: null,
					memTotal: 8e9,
					memUsed: 2e9,
					diskTotal: null,
					diskFree: null,
				},
			}),
		);
		assert.deepEqual(windows?.cpu, {
			percent: 0,
			value: "0%",
			extra: "4 cores",
		});
		assert.equal(windows?.disk, null);
		assert.deepEqual(sessionsMeter(view()), {
			percent: 50,
			value: "1/2",
			extra: "1 session",
		});
	});
});
