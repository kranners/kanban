import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createSignalSampler,
	idleFromIoreg,
	lidFromAcpi,
	lidFromIoreg,
	listCheckouts,
	parseAllowList,
	parseGitConfigRemote,
	powerFromPmset,
	powerFromSupplies,
	readCheckout,
	servedFolders,
	sleepFromPmset,
	sleepFromSystemctl,
	thermalFromPmset,
	thermalFromZones,
} from "./signals.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";
const other = "fedcba9876543210fedcba9876543210fedcba98";

const pmsetBattery = [
	"Now drawing from 'Battery Power'",
	" -InternalBattery-0 (id=1234567)\t62%; discharging; 3:10 remaining present: true",
].join("\n");
const pmsetMains = [
	"Now drawing from 'AC Power'",
	" -InternalBattery-0 (id=1234567)\t100%; charged; 0:00 remaining present: true",
].join("\n");
const pmsetDesktop = "Now drawing from 'AC Power'\n";
const ioregLid = `+-o AppleACPIPlatformExpert
    "AppleClamshellCausesSleep" = Yes
    "AppleClamshellState" = Yes
`;
const ioregIdle = `    | |   "HIDIdleTime" = 45123456789
    | |   "HIDParameters" = {}
`;
const thermNone = [
	"Note: No thermal warning level has been recorded",
	"Note: No performance warning level has been recorded",
	"Note: No CPU power status has been recorded",
].join("\n");
const thermLimited = "CPU_Scheduler_Limit \t= 100\nCPU_Speed_Limit \t= 70\n";
const pmsetCustom = [
	"System-wide power settings:",
	"Currently in use:",
	" standby              1",
	" displaysleep         10",
	" sleep                1 (sleep prevented by caffeinate)",
	" hibernatemode        3",
].join("\n");

describe("macOS readings", () => {
	it("reads power source and battery from pmset", () => {
		assert.deepEqual(powerFromPmset(pmsetBattery), {
			power: "battery",
			batteryPercent: 62,
		});
		assert.deepEqual(powerFromPmset(pmsetMains), {
			power: "mains",
			batteryPercent: 100,
		});
		assert.deepEqual(powerFromPmset(pmsetDesktop), {
			power: "mains",
			batteryPercent: null,
		});
		assert.deepEqual(powerFromPmset(""), {
			power: null,
			batteryPercent: null,
		});
	});

	it("reads the lid from the clamshell state, null without one", () => {
		assert.equal(lidFromIoreg(ioregLid), false);
		assert.equal(lidFromIoreg('"AppleClamshellState" = No'), true);
		assert.equal(lidFromIoreg("+-o Root"), null);
	});

	it("reads only the idle counter, in whole seconds", () => {
		assert.equal(idleFromIoreg(ioregIdle), 45);
		assert.equal(idleFromIoreg("nothing"), null);
	});

	it("reads thermal pressure", () => {
		assert.equal(thermalFromPmset(thermNone), "nominal");
		assert.equal(thermalFromPmset(thermLimited), "throttled");
		assert.equal(
			thermalFromPmset("Thermal Warning Level = 0\nCPU_Speed_Limit = 100"),
			"nominal",
		);
		assert.equal(thermalFromPmset("Thermal Warning Level = 2"), "throttled");
		assert.equal(thermalFromPmset(""), null);
	});

	it("reads the sleep setting, 0 for never", () => {
		assert.equal(sleepFromPmset(pmsetCustom), 1);
		assert.equal(sleepFromPmset(" sleep                0\n"), 0);
		assert.equal(sleepFromPmset("displaysleep 10"), null);
		assert.equal(
			sleepFromPmset(` SleepDisabled		1
${pmsetCustom}`),
			0,
		);
	});
});

describe("Linux readings", () => {
	it("reads power supplies", () => {
		assert.deepEqual(
			powerFromSupplies([
				{ type: "Battery", online: null, capacity: "48" },
				{ type: "Mains", online: "0", capacity: null },
			]),
			{ power: "battery", batteryPercent: 48 },
		);
		assert.deepEqual(
			powerFromSupplies([
				{ type: "Battery", online: null, capacity: "90" },
				{ type: "Mains", online: "1", capacity: null },
			]),
			{ power: "mains", batteryPercent: 90 },
		);
		assert.deepEqual(
			powerFromSupplies([
				{ type: "Battery", online: null, capacity: "30", scope: "Device" },
			]),
			{ power: "mains", batteryPercent: null },
		);
		assert.deepEqual(powerFromSupplies([]), {
			power: "mains",
			batteryPercent: null,
		});
	});

	it("reads the lid and thermal zones", () => {
		assert.equal(lidFromAcpi("state:      open\n"), true);
		assert.equal(lidFromAcpi("state:      closed\n"), false);
		assert.equal(lidFromAcpi(""), null);
		assert.equal(thermalFromZones([45_000, 61_000]), "nominal");
		assert.equal(thermalFromZones([45_000, 95_000]), "throttled");
		assert.equal(thermalFromZones([]), null);
	});

	it("only knows a masked sleep.target as never sleeping", () => {
		assert.equal(sleepFromSystemctl("masked\n"), 0);
		assert.equal(sleepFromSystemctl("static\n"), null);
	});
});

describe("checkouts", () => {
	it("reads origin without credentials, and the first remote otherwise", () => {
		assert.equal(
			parseGitConfigRemote(
				'[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://example.com/up/tool.git\n[remote "origin"]\n\turl = https://user:secret@example.com/me/tool.git\n',
			),
			"https://example.com/me/tool.git",
		);
		assert.equal(
			parseGitConfigRemote(
				'[remote "fork"]\n\turl = git@example.com:me/x.git\n',
			),
			"git@example.com:me/x.git",
		);
		assert.equal(parseGitConfigRemote("[core]\n"), null);
		for (const [raw, clean] of [
			[
				'"https://user:tok;en@example.com/me/x.git"',
				"https://example.com/me/x.git",
			],
			["https://u:p@ss@example.com/me/x", "https://example.com/me/x"],
			["https://example.com/me/x?token=abc#frag", "https://example.com/me/x"],
			["deploy@example.com:me/x.git", "git@example.com:me/x.git"],
		])
			assert.equal(
				parseGitConfigRemote(`[remote "origin"]\n\turl = ${raw}\n`),
				clean,
			);
	});

	it("reads HEAD through a loose ref, packed refs and a worktree", async () => {
		const root = await mkdtemp(join(tmpdir(), "signals-"));
		const loose = join(root, "loose");
		await mkdir(join(loose, ".git", "refs", "heads"), { recursive: true });
		await writeFile(join(loose, ".git", "HEAD"), "ref: refs/heads/main\n");
		await writeFile(join(loose, ".git", "refs", "heads", "main"), `${sha}\n`);
		await writeFile(
			join(loose, ".git", "config"),
			'[remote "origin"]\n\turl = https://example.com/me/loose.git\n',
		);
		assert.deepEqual(await readCheckout(loose), {
			path: loose,
			remote: "https://example.com/me/loose.git",
			commit: sha,
		});

		const packed = join(root, "packed");
		await mkdir(join(packed, ".git"), { recursive: true });
		await writeFile(join(packed, ".git", "HEAD"), "ref: refs/heads/dev\n");
		await writeFile(
			join(packed, ".git", "packed-refs"),
			`# pack-refs with: peeled\n${other} refs/heads/dev\n`,
		);
		assert.equal((await readCheckout(packed))?.commit, other);
		assert.equal((await readCheckout(packed))?.remote, null);

		const tree = join(root, "tree");
		const treeGit = join(loose, ".git", "worktrees", "tree");
		await mkdir(treeGit, { recursive: true });
		await mkdir(tree);
		await writeFile(join(tree, ".git"), `gitdir: ${treeGit}\n`);
		await writeFile(join(treeGit, "HEAD"), `${other}\n`);
		await writeFile(join(treeGit, "commondir"), "../..\n");
		assert.deepEqual(await readCheckout(tree), {
			path: tree,
			remote: "https://example.com/me/loose.git",
			commit: other,
		});

		const plain = join(root, "plain");
		await mkdir(plain);
		assert.equal(await readCheckout(plain), null);

		const found = await listCheckouts([root, join(root, "missing")]);
		assert.deepEqual(
			found.map((checkout) => checkout.path),
			[loose, packed, tree],
		);
	});

	it("serves the workspace folder and each local side of --paths", () => {
		assert.deepEqual(
			servedFolders(
				[
					["/hub/code", "~/code"],
					["/hub/x", "/srv/x"],
				],
				"/home/me",
			),
			["/home/me/workspace", "/home/me/code", "/srv/x"],
		);
	});
});

describe("parseAllowList", () => {
	it("is empty when the file is absent or broken", () => {
		assert.deepEqual(parseAllowList(null), { classes: [], ceilings: {} });
		assert.deepEqual(parseAllowList("{"), { classes: [], ceilings: {} });
		assert.deepEqual(parseAllowList("[]"), { classes: [], ceilings: {} });
	});

	it("keeps well-formed classes and ceilings only", () => {
		assert.deepEqual(
			parseAllowList(
				JSON.stringify({
					classes: ["build", "Bad Name", 3, "test"],
					ceilings: { memoryGb: 4, sessions: 2, nope: -1, also: "x" },
				}),
			),
			{ classes: ["build", "test"], ceilings: { sessions: 2 } },
		);
	});
});

describe("createSignalSampler", () => {
	const darwinRun =
		(calls: string[]) =>
		async (file: string, args: string[]): Promise<string | null> => {
			const key = `${file.split("/").pop()} ${args.join(" ")}`;
			calls.push(key);
			if (key === "pmset -g batt") return pmsetBattery;
			if (key.startsWith("ioreg -r -k AppleClamshellState")) return ioregLid;
			if (key === "pmset -g therm") return thermNone;
			if (key.startsWith("ioreg -c IOHIDSystem")) return ioregIdle;
			if (key === "pmset -g") return pmsetCustom;
			return null;
		};

	it("reads a Mac, the slow readings only every few minutes", async () => {
		const calls: string[] = [];
		let at = 0;
		const sample = createSignalSampler({
			platform: "darwin",
			run: darwinRun(calls),
			read: async () => JSON.stringify({ classes: ["build"] }),
			checkouts: async () => [{ path: "/w/tool", remote: null, commit: sha }],
			now: () => at,
		});
		const first = await sample();
		assert.deepEqual(first, {
			power: "battery",
			batteryPercent: 62,
			lidOpen: false,
			thermal: "nominal",
			idleSeconds: 45,
			sleepMinutes: 1,
			checkouts: [{ path: "/w/tool", remote: null, commit: sha }],
			allow: { classes: ["build"], ceilings: {} },
			why: {},
		});
		calls.length = 0;
		at += 5_000;
		await sample();
		assert.deepEqual(calls, ["ioreg -c IOHIDSystem -d 4"]);
		calls.length = 0;
		at += 30_000;
		await sample();
		assert.equal(calls.includes("pmset -g batt"), true);
		assert.equal(calls.includes("pmset -g"), false);
		calls.length = 0;
		at += 5 * 60_000;
		await sample();
		assert.equal(calls.includes("pmset -g"), true);
	});

	it("reads a Linux laptop from /sys and /proc, idle null with why", async () => {
		const files: Record<string, string> = {
			"/sys/class/power_supply/BAT0/type": "Battery\n",
			"/sys/class/power_supply/BAT0/capacity": "77\n",
			"/sys/class/power_supply/AC/type": "Mains\n",
			"/sys/class/power_supply/AC/online": "1\n",
			"/proc/acpi/button/lid/LID0/state": "state:      open\n",
			"/sys/class/thermal/thermal_zone0/temp": "52000\n",
		};
		const dirs: Record<string, string[]> = {
			"/sys/class/power_supply": ["AC", "BAT0"],
			"/proc/acpi/button/lid": ["LID0"],
			"/sys/class/thermal": ["cooling_device0", "thermal_zone0"],
		};
		const sample = createSignalSampler({
			platform: "linux",
			run: async () => "enabled\n",
			read: async (path) => files[path] ?? null,
			list: async (path) => dirs[path] ?? [],
		});
		const signals = await sample();
		assert.equal(signals.power, "mains");
		assert.equal(signals.batteryPercent, 77);
		assert.equal(signals.lidOpen, true);
		assert.equal(signals.thermal, "nominal");
		assert.equal(signals.idleSeconds, null);
		assert.equal(signals.sleepMinutes, null);
		assert.match(signals.why.idleSeconds ?? "", /Linux/);
		assert.match(signals.why.sleepMinutes ?? "", /sleep/);
		assert.deepEqual(signals.allow, { classes: [], ceilings: {} });
	});

	it("is all null, each with a reason, where nothing can be read", async () => {
		const signals = await createSignalSampler({
			platform: "win32",
			run: async () => null,
			read: async () => null,
		})();
		for (const name of [
			"power",
			"batteryPercent",
			"lidOpen",
			"thermal",
			"idleSeconds",
			"sleepMinutes",
		] as const) {
			assert.equal(signals[name], null, name);
			assert.ok(signals.why[name], name);
		}
		assert.deepEqual(signals.checkouts, []);
	});

	it("never holds a heartbeat on a stalled read, sending the last one instead", async () => {
		let release = () => {};
		let stall = false;
		const sample = createSignalSampler({
			platform: "darwin",
			run: (file, args) =>
				stall
					? new Promise((resolve) => {
							release = () => resolve(null);
						})
					: darwinRun([])(file, args),
			read: async () => null,
			waitMs: 20,
		});
		assert.equal((await sample()).idleSeconds, 45);
		stall = true;
		const started = performance.now();
		const held = await sample();
		assert.ok(performance.now() - started < 500);
		assert.equal(held.idleSeconds, 45);
		release();
	});

	it("gives a reason for each Mac reading that fails", async () => {
		const signals = await createSignalSampler({
			platform: "darwin",
			run: async () => null,
			read: async () => null,
		})();
		assert.equal(signals.idleSeconds, null);
		assert.ok(signals.why.idleSeconds);
		assert.ok(signals.why.power);
	});
});
