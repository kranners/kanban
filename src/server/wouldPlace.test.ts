import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunnerSignals, RunnerView } from "../shared/runners.ts";
import {
	createPlacementLog,
	normalizeRemote,
	type PlacementCandidate,
	wouldPlace,
} from "./wouldPlace.ts";

const gib = 1024 ** 3;
const sha = "0123456789abcdef0123456789abcdef01234567";

const usage = {
	cpus: 8,
	cpuPercent: 10,
	load1: 1,
	memTotal: 16 * gib,
	memUsed: 6 * gib,
	diskTotal: null,
	diskFree: null,
};

const view = (id: string, overrides: Partial<RunnerView> = {}): RunnerView => ({
	id,
	name: id,
	label: id,
	local: id === "local",
	runsOn: id === "local" ? "local" : `runner_${id}`,
	hostname: id,
	platform: "darwin",
	state: "online",
	lastSeen: 1,
	goneSince: null,
	usage: {
		cpus: 8,
		cpuPercent: 10,
		load1: 1,
		memTotal: 16 * gib,
		memUsed: 6 * gib,
		diskTotal: null,
		diskFree: null,
	},
	cap: 4,
	sessions: [],
	...overrides,
});

const signals = (overrides: Partial<RunnerSignals> = {}): RunnerSignals => ({
	power: "mains",
	batteryPercent: 100,
	lidOpen: true,
	thermal: "nominal",
	idleSeconds: 600,
	sleepMinutes: 0,
	checkouts: [
		{
			path: "/Users/me/workspace/tool",
			remote: "git@example.com:me/tool.git",
			commit: sha,
		},
	],
	allow: { classes: [], ceilings: {} },
	why: {},
	...overrides,
});

const machine = (
	id: string,
	viewOverrides: Partial<RunnerView> = {},
	signalOverrides: Partial<RunnerSignals> | null = {},
): PlacementCandidate => ({
	view: view(id, viewOverrides),
	signals: signalOverrides === null ? null : signals(signalOverrides),
});

const launch = {
	cwd: "/Users/me/workspace/tool/src",
	runsOn: "runner_work",
};

describe("normalizeRemote", () => {
	it("reads ssh and https remotes of one repository as the same", () => {
		assert.equal(
			normalizeRemote("git@example.com:me/tool.git"),
			normalizeRemote("https://token@example.com/me/tool/"),
		);
	});
});

describe("wouldPlace", () => {
	it("keeps the asked machine when it fits best", () => {
		const choice = wouldPlace(launch, [
			machine("work"),
			machine("home", { usage: { ...usage, memUsed: 15 * gib } }),
		]);
		assert.equal(choice.runsOn, "runner_work");
		assert.match(choice.reason, /^work has tool, 10\.0 GB free, load 1\.0/);
		assert.match(choice.reason, /home only 1\.0 GB free/);
	});

	it("moves off a machine someone is using on battery with the lid shut", () => {
		const choice = wouldPlace(launch, [
			machine("work", {}, { idleSeconds: 30 }),
			machine(
				"home",
				{},
				{
					power: "battery",
					batteryPercent: 40,
					lidOpen: false,
					checkouts: [
						{
							path: "/Users/other/code/tool",
							remote: "https://example.com/me/tool",
							commit: null,
						},
					],
				},
			),
			machine(
				"spare",
				{},
				{
					checkouts: [
						{
							path: "/Users/other/w/renamed",
							remote: "https://example.com/me/tool.git",
							commit: sha,
						},
					],
				},
			),
		]);
		assert.equal(choice.runsOn, "runner_spare");
		assert.match(choice.reason, /work someone was at the keyboard 30s ago/);
		assert.match(choice.reason, /home on battery \(40%\), lid closed/);
	});

	it("needs the checkout, the same OS, room and a cool machine", () => {
		const choice = wouldPlace(launch, [
			machine("work", {
				sessions: Array(4).fill({}) as RunnerView["sessions"],
			}),
			machine("local", { platform: "linux" }),
			machine("cold", {}, { checkouts: [] }),
			machine("hot", {}, { thermal: "throttled" }),
			machine("busy", {
				usage: { ...usage, load1: 12 },
			}),
			machine("old", {}, null),
			machine("gone", { state: "asleep", usage: null }),
		]);
		assert.equal(choice.runsOn, null);
		assert.match(choice.reason, /^no machine fits: /);
		for (const words of [
			"work at its cap (4 of 4)",
			"local runs linux, not darwin",
			"cold has no checkout of tool",
			"hot running hot",
			"busy load 12.0 on 8 cores",
			"old reports no placement signals",
			"gone asleep",
		])
			assert.ok(choice.reason.includes(words), words);
	});

	it("matches by folder name when the asked machine reported no checkout", () => {
		const choice = wouldPlace({ cwd: "/srv/tool", runsOn: "local" }, [
			machine("local", { platform: "linux" }, { checkouts: [] }),
			machine("work", { platform: "linux" }),
		]);
		assert.equal(choice.runsOn, "runner_work");
	});

	it("says so when it knows no machines", () => {
		assert.equal(
			wouldPlace(launch, []).reason,
			"no machine fits: no machines known",
		);
	});
});

describe("createPlacementLog", () => {
	it("logs one line per launch, and nothing while the off-switch is set", () => {
		const lines: string[] = [];
		let off = false;
		const log = createPlacementLog({
			off: () => off,
			log: (line) => lines.push(line),
			now: () => 42,
		});
		const entry = log.record(
			{ id: "abc", cwd: launch.cwd, runsOn: launch.runsOn, label: "work" },
			[machine("work")],
		);
		assert.equal(entry?.wouldGo, "work");
		assert.match(
			lines[0] ?? "",
			/^would-place: launch abc went to work, would have gone to work: work has tool/,
		);
		off = true;
		assert.equal(
			log.record(
				{ id: "def", cwd: launch.cwd, runsOn: launch.runsOn, label: "work" },
				[machine("work")],
			),
			null,
		);
		assert.equal(lines.length, 1);
		assert.equal(log.enabled(), false);
		assert.deepEqual(
			log.recent().map((kept) => kept.launchId),
			["abc"],
		);
	});
});
