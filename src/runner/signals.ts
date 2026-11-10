// Placement signals: the cheap facts a hub would weigh before putting work on
// this machine. Each is read without new permissions (no root, no screen or
// accessibility access, no port, no daemon) and is null, with the reason, when
// the platform can't tell. They only report; nothing here acts on the machine.
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	maxAllowClasses,
	maxCheckouts,
	type RunnerAllowList,
	type RunnerCheckout,
	type RunnerSignals,
	remoteWithoutCredentials,
	type SignalName,
	signalNames,
} from "../shared/runners.ts";

type Run = (file: string, args: string[]) => Promise<string | null>;

const runFile: Run = (file, args) =>
	new Promise((resolve) => {
		execFile(file, args, { timeout: 3_000 }, (error, stdout) =>
			// systemctl is-enabled exits 1 for "masked" but still says so.
			resolve(
				!error || (typeof error.code === "number" && stdout) ? stdout : null,
			),
		);
	});

const readText = (path: string): Promise<string | null> =>
	readFile(path, "utf8").catch(() => null);

// macOS `pmset -g batt`: "Now drawing from 'AC Power'" and, on a laptop,
// "-InternalBattery-0 (id=…)	85%; charging; …".
export const powerFromPmset = (
	text: string,
): { power: "mains" | "battery" | null; batteryPercent: number | null } => {
	const source = text.match(/drawing from '([^']+)'/)?.[1] ?? "";
	const percent = text.match(/InternalBattery[^\n]*?\t(\d{1,3})%/)?.[1];
	return {
		power: /battery/i.test(source)
			? "battery"
			: /AC|UPS/i.test(source)
				? "mains"
				: null,
		batteryPercent: percent === undefined ? null : Number(percent),
	};
};

// macOS `ioreg -r -k AppleClamshellState -d 1`: "AppleClamshellState" = No is open.
export const lidFromIoreg = (text: string): boolean | null => {
	const state = text.match(/"AppleClamshellState"\s*=\s*(Yes|No)/)?.[1];
	return state === undefined ? null : state === "No";
};

// macOS `ioreg -c IOHIDSystem -d 4`: HIDIdleTime is nanoseconds since the last
// keyboard or mouse input. Only the counter is read, never the input.
export const idleFromIoreg = (text: string): number | null => {
	const ns = text.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
	return ns === undefined ? null : Math.floor(Number(ns) / 1e9);
};

// macOS `pmset -g therm`: nothing recorded is nominal; a recorded warning
// level above 0 or a CPU speed limit under 100 means the machine is throttling.
export const thermalFromPmset = (text: string): RunnerSignals["thermal"] => {
	const speed = text.match(/CPU_Speed_Limit\s*=\s*(\d+)/)?.[1];
	const level = text.match(
		/(?:Thermal|Performance) Warning Level\s*=\s*(\d+)/i,
	)?.[1];
	if (
		(speed !== undefined && Number(speed) < 100) ||
		(level !== undefined && Number(level) > 0)
	)
		return "throttled";
	if (
		/No thermal warning level has been recorded/i.test(text) ||
		speed !== undefined ||
		level !== undefined
	)
		return "nominal";
	return null;
};

// macOS `pmset -g`: the active profile's "sleep" line, minutes, 0 for never.
export const sleepFromPmset = (text: string): number | null => {
	if (/^\s*SleepDisabled\s+1\b/m.test(text)) return 0;
	const minutes = text.match(/^\s*sleep\s+(\d+)/m)?.[1];
	return minutes === undefined ? null : Number(minutes);
};

// Linux /sys/class/power_supply: a Battery's capacity and a Mains or USB
// supply's online flag. A machine with no battery is on mains.
export const powerFromSupplies = (
	all: {
		type: string;
		online: string | null;
		capacity: string | null;
		scope?: string | null;
	}[],
): { power: "mains" | "battery" | null; batteryPercent: number | null } => {
	const supplies = all.filter((supply) => supply.scope !== "Device");
	const batteries = supplies.filter((supply) => supply.type === "Battery");
	const external = supplies.filter((supply) =>
		["Mains", "USB", "USB_C", "USB_PD"].includes(supply.type),
	);
	const percent = batteries
		.map((battery) => Number(battery.capacity))
		.find((value) => Number.isFinite(value) && value >= 0 && value <= 100);
	const plugged = external.some((supply) => supply.online === "1");
	return {
		power:
			batteries.length === 0 || plugged
				? "mains"
				: external.length > 0
					? "battery"
					: null,
		batteryPercent: percent ?? null,
	};
};

// Linux /proc/acpi/button/lid/*/state: "state:      open".
export const lidFromAcpi = (text: string): boolean | null => {
	const state = text.match(/state:\s*(open|closed)/)?.[1];
	return state === undefined ? null : state === "open";
};

// Linux thermal zones in millidegrees: hot from 90 °C, where laptops throttle.
export const thermalFromZones = (
	millidegrees: number[],
): RunnerSignals["thermal"] => {
	const readings = millidegrees.filter(
		(value) => Number.isFinite(value) && value > 0,
	);
	if (readings.length === 0) return null;
	return Math.max(...readings) >= 90_000 ? "throttled" : "nominal";
};

// systemd's sleep.target masked means the machine never sleeps by itself.
export const sleepFromSystemctl = (text: string): number | null =>
	text.trim() === "masked" ? 0 : null;

export const parseGitConfigRemote = (text: string): string | null => {
	let inOrigin = false;
	let first: string | null = null;
	let current = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const section = line.match(/^\[remote\s+"([^"]+)"\]$/);
		if (section) {
			current = true;
			inOrigin = section[1] === "origin";
			continue;
		}
		if (line.startsWith("[")) {
			current = false;
			inOrigin = false;
			continue;
		}
		const url = current ? line.match(/^url\s*=\s*(.+)$/)?.[1] : undefined;
		if (url) {
			const clean = remoteWithoutCredentials(url);
			if (inOrigin) return clean;
			first ??= clean;
		}
	}
	return first;
};

export const parsePackedRef = (text: string, ref: string): string | null => {
	for (const line of text.split("\n")) {
		const [sha, name] = line.trim().split(/\s+/);
		if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
	}
	return null;
};

const isSha = (value: string) => /^[0-9a-f]{40,64}$/.test(value);

// Reads a checkout's origin and HEAD commit from git's own files, without
// running git and without reading anything of the working tree.
export const readCheckout = async (
	path: string,
): Promise<RunnerCheckout | null> => {
	const dotGit = join(path, ".git");
	const info = await stat(dotGit).catch(() => null);
	if (!info) return null;
	let gitDir = dotGit;
	let commonDir = dotGit;
	if (info.isFile()) {
		const pointer = (await readText(dotGit))?.match(/^gitdir:\s*(.+)$/m)?.[1];
		if (!pointer) return null;
		gitDir = pointer.trim().startsWith("/")
			? pointer.trim()
			: join(path, pointer.trim());
		const common = (await readText(join(gitDir, "commondir")))?.trim();
		commonDir = common
			? common.startsWith("/")
				? common
				: join(gitDir, common)
			: gitDir;
	}
	const head = (await readText(join(gitDir, "HEAD")))?.trim() ?? "";
	let commit: string | null = null;
	if (isSha(head)) commit = head;
	else {
		const ref = head.match(/^ref:\s*(refs\/\S+)$/)?.[1];
		if (ref && !ref.includes("..")) {
			const loose =
				(await readText(join(gitDir, ref)))?.trim() ??
				(await readText(join(commonDir, ref)))?.trim();
			commit =
				loose && isSha(loose)
					? loose
					: parsePackedRef(
							(await readText(join(commonDir, "packed-refs"))) ?? "",
							ref,
						);
		}
	}
	const config = (await readText(join(commonDir, "config"))) ?? "";
	return { path, remote: parseGitConfigRemote(config), commit };
};

// The checkouts directly inside the folders the runner serves: the workspace
// folder sessions start in and each local side of --paths.
export const listCheckouts = async (
	folders: readonly string[],
): Promise<RunnerCheckout[]> => {
	const found: RunnerCheckout[] = [];
	const seen = new Set<string>();
	for (const folder of folders) {
		const entries = await readdir(folder, { withFileTypes: true }).catch(
			() => [],
		);
		const candidates = [
			folder,
			...entries
				.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
				.map((entry) => join(folder, entry.name))
				.sort(),
		];
		for (const path of candidates) {
			if (seen.has(path) || found.length >= maxCheckouts) continue;
			seen.add(path);
			const checkout = await readCheckout(path);
			if (checkout) found.push(checkout);
		}
	}
	return found;
};

/** The workspace folder sessions start in, and each local side of --paths. */
export const servedFolders = (
	paths: readonly [string, string][],
	home: string = homedir(),
): string[] => [
	...new Set(
		[join(home, "workspace"), ...paths.map(([, local]) => local)].map((path) =>
			path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path,
		),
	),
];

const classPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// The machine's own say on what work it takes, from a file only someone at
// that machine can write. The hub reads it and has no way to set it.
export const parseAllowList = (text: string | null): RunnerAllowList => {
	if (text === null) return { classes: [], ceilings: {} };
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { classes: [], ceilings: {} };
	}
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return { classes: [], ceilings: {} };
	const { classes, ceilings } = body as Record<string, unknown>;
	return {
		classes: Array.isArray(classes)
			? classes
					.filter(
						(name): name is string =>
							typeof name === "string" && classPattern.test(name),
					)
					.slice(0, maxAllowClasses)
			: [],
		ceilings:
			typeof ceilings === "object" &&
			ceilings !== null &&
			!Array.isArray(ceilings)
				? Object.fromEntries(
						Object.entries(ceilings)
							.filter(
								([name, value]) =>
									classPattern.test(name) &&
									typeof value === "number" &&
									Number.isFinite(value) &&
									value >= 0,
							)
							.slice(0, maxAllowClasses),
					)
				: {},
	};
};

export const allowListPath = (home: string = homedir()) =>
	join(home, ".config", "kanban", "runner-allow.json");

const pmset = "/usr/bin/pmset";
const ioreg = "/usr/sbin/ioreg";

const fastEveryMs = 30_000;
const slowEveryMs = 5 * 60_000;

export type SignalSamplerOptions = {
	platform?: NodeJS.Platform;
	run?: Run;
	read?: (path: string) => Promise<string | null>;
	list?: (path: string) => Promise<string[]>;
	checkouts?: () => Promise<RunnerCheckout[]>;
	allowFile?: string;
	now?: () => number;
	/** How long a heartbeat waits for a fresh reading before sending the last one. */
	waitMs?: number;
};

export type SignalSampler = () => Promise<RunnerSignals>;

const unsupported = (platform: string) =>
	`${platform} has no reading for this the runner can take`;

/**
 * Idle is read on every heartbeat, since it goes stale fastest; power, lid and
 * heat every 30 s; the sleep setting, checkouts and allow-list every 5 minutes,
 * so a managed laptop pays a few cheap reads and nothing heavy.
 */
export const createSignalSampler = ({
	platform = process.platform,
	run = runFile,
	read = readText,
	list = (path) => readdir(path).catch(() => []),
	checkouts = () => Promise.resolve([]),
	allowFile = allowListPath(),
	now = Date.now,
	waitMs = 1_000,
}: SignalSamplerOptions = {}): SignalSampler => {
	const stalled = (): RunnerSignals => ({
		power: null,
		batteryPercent: null,
		lidOpen: null,
		thermal: null,
		idleSeconds: null,
		sleepMinutes: null,
		checkouts: [],
		allow: { classes: [], ceilings: {} },
		why: Object.fromEntries(
			signalNames.map((name) => [name, "the first reading hasn't finished"]),
		),
	});
	const why: Partial<Record<SignalName, string>> = {};
	const note = (name: SignalName, value: unknown, reason: string) => {
		if (value === null) why[name] = reason;
		else delete why[name];
	};
	let fastAt = -Infinity;
	let slowAt = -Infinity;
	let fast: Pick<
		RunnerSignals,
		"power" | "batteryPercent" | "lidOpen" | "thermal"
	> = { power: null, batteryPercent: null, lidOpen: null, thermal: null };
	let slow: Pick<RunnerSignals, "sleepMinutes" | "checkouts" | "allow"> = {
		sleepMinutes: null,
		checkouts: [],
		allow: { classes: [], ceilings: {} },
	};

	const readFast = async () => {
		if (platform === "darwin") {
			const [batt, lid, therm] = await Promise.all([
				run(pmset, ["-g", "batt"]),
				run(ioreg, ["-r", "-k", "AppleClamshellState", "-d", "1"]),
				run(pmset, ["-g", "therm"]),
			]);
			const power = batt
				? powerFromPmset(batt)
				: { power: null, batteryPercent: null };
			fast = {
				...power,
				lidOpen: lid ? lidFromIoreg(lid) : null,
				thermal: therm ? thermalFromPmset(therm) : null,
			};
			note(
				"power",
				fast.power,
				batt ? "pmset named no power source" : "pmset failed",
			);
			note(
				"batteryPercent",
				fast.batteryPercent,
				batt ? "no internal battery" : "pmset failed",
			);
			note(
				"lidOpen",
				fast.lidOpen,
				lid ? "no clamshell, so no lid to read" : "ioreg failed",
			);
			note(
				"thermal",
				fast.thermal,
				therm ? "pmset gave no thermal state" : "pmset failed",
			);
			return;
		}
		if (platform === "linux") {
			const base = "/sys/class/power_supply";
			const supplies = await Promise.all(
				(await list(base)).map(async (name) => ({
					type: (await read(join(base, name, "type")))?.trim() ?? "",
					online: (await read(join(base, name, "online")))?.trim() ?? null,
					capacity: (await read(join(base, name, "capacity")))?.trim() ?? null,
					scope: (await read(join(base, name, "scope")))?.trim() ?? null,
				})),
			);
			const lids = await list("/proc/acpi/button/lid");
			const lidText = lids[0]
				? await read(join("/proc/acpi/button/lid", lids[0], "state"))
				: null;
			const zones = (await list("/sys/class/thermal")).filter((name) =>
				name.startsWith("thermal_zone"),
			);
			const temps = await Promise.all(
				zones.map(async (zone) =>
					Number(
						(await read(join("/sys/class/thermal", zone, "temp")))?.trim(),
					),
				),
			);
			fast = {
				...powerFromSupplies(supplies),
				lidOpen: lidText ? lidFromAcpi(lidText) : null,
				thermal: thermalFromZones(temps),
			};
			note("power", fast.power, "no power supply readable in /sys");
			note("batteryPercent", fast.batteryPercent, "no battery");
			note("lidOpen", fast.lidOpen, "no ACPI lid switch");
			note("thermal", fast.thermal, "no thermal zones in /sys");
			return;
		}
		for (const name of [
			"power",
			"batteryPercent",
			"lidOpen",
			"thermal",
		] as const)
			why[name] = unsupported(platform);
	};

	const readIdle = async (): Promise<number | null> => {
		if (platform === "darwin") {
			const text = await run(ioreg, ["-c", "IOHIDSystem", "-d", "4"]);
			const idle = text ? idleFromIoreg(text) : null;
			note(
				"idleSeconds",
				idle,
				text ? "ioreg gave no HIDIdleTime" : "ioreg failed",
			);
			return idle;
		}
		why.idleSeconds =
			platform === "linux"
				? "Linux keeps no input idle counter readable outside the desktop session"
				: unsupported(platform);
		return null;
	};

	const readSlow = async () => {
		let sleepMinutes: number | null = null;
		if (platform === "darwin") {
			const text = await run(pmset, ["-g"]);
			sleepMinutes = text ? sleepFromPmset(text) : null;
			note(
				"sleepMinutes",
				sleepMinutes,
				text ? "pmset gave no sleep setting" : "pmset failed",
			);
		} else if (platform === "linux") {
			const text = await run("systemctl", ["is-enabled", "sleep.target"]);
			sleepMinutes = text ? sleepFromSystemctl(text) : null;
			note(
				"sleepMinutes",
				sleepMinutes,
				"Linux keeps no idle sleep timer the runner can read; only a masked sleep.target shows as 0",
			);
		} else why.sleepMinutes = unsupported(platform);
		slow = {
			sleepMinutes,
			checkouts: await checkouts().catch(() => []),
			allow: parseAllowList(await read(allowFile)),
		};
	};

	const refresh = async (): Promise<RunnerSignals> => {
		const at = now();
		if (at - slowAt >= slowEveryMs) {
			slowAt = at;
			await readSlow();
		}
		if (at - fastAt >= fastEveryMs) {
			fastAt = at;
			await readFast();
		}
		const idleSeconds = await readIdle();
		return { ...fast, idleSeconds, ...slow, why: { ...why } };
	};

	// A stalled read must never hold up a heartbeat: the beat waits at most
	// waitMs, then sends the last finished reading while the slow one carries on.
	let last: RunnerSignals | null = null;
	let pending: Promise<RunnerSignals> | null = null;
	return async () => {
		pending ??= refresh()
			.then((signals) => {
				last = signals;
				return signals;
			})
			.finally(() => {
				pending = null;
			});
		const timeout = new Promise<null>((resolve) => {
			const timer = setTimeout(() => resolve(null), waitMs);
			timer.unref?.();
		});
		return (await Promise.race([pending, timeout])) ?? last ?? stalled();
	};
};
