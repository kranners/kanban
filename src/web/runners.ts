import { signal } from "@preact/signals";
import type { RunnerView } from "../shared/runners.ts";

export const runners = signal<RunnerView[]>([]);

/** How long a machine that dropped off keeps the Usage rail badge lit. */
export const recentlyGoneMs = 60 * 60_000;

export const platformName = (platform: string | null): string => {
	switch (platform) {
		case "darwin":
			return "macOS";
		case "linux":
			return "Linux";
		case "win32":
			return "Windows";
		default:
			return platform ?? "";
	}
};

/** The board's own machine, as the hub reports it. */
export const localRunner = (
	views: readonly RunnerView[] = runners.value,
): RunnerView | undefined => views.find((runner) => runner.local);

/** "This Mac" for a board on a Mac, else its machine's name, such as spike. */
export const localMachineLabel = (
	views: readonly RunnerView[] = runners.value,
): string => localRunner(views)?.label ?? "This Mac";

/** The same, for the middle of a sentence: "this Mac" or "spike". */
export const localMachinePhrase = (
	views: readonly RunnerView[] = runners.value,
): string => {
	const label = localMachineLabel(views);
	return label === "This Mac" ? "this Mac" : label;
};

/** Whether the board runs on a Mac, so its native folder panel can open. */
export const localIsMac = (
	views: readonly RunnerView[] = runners.value,
): boolean => localRunner(views)?.platform === "darwin";

// The same reasons the hub gives, so the picker can say why up front.
export const runnerBlocker = (runner: RunnerView): string | null => {
	if (runner.local) return null;
	if (runner.lastSeen === null)
		return `${runner.label}'s runner hasn't connected to the board`;
	if (runner.state !== "online") return `${runner.label} is ${runner.state}`;
	return runner.sessions.length >= runner.cap
		? `${runner.label} is at its cap (${runner.sessions.length} of ${runner.cap})`
		: null;
};

export const stateLabel = (
	runner: RunnerView,
	ago: (at: number) => string,
): string => {
	if (runner.state === "online") return "Online";
	const state = runner.state === "asleep" ? "Asleep" : "Offline";
	return runner.lastSeen === null
		? `${state} · not seen yet`
		: `${state} · seen ${ago(runner.lastSeen)}`;
};

/** Machines that went offline (not to sleep) within the last hour. */
export const recentlyGone = (
	views: readonly RunnerView[],
	now: number,
): RunnerView[] =>
	views.filter(
		(runner) =>
			runner.state === "offline" &&
			runner.goneSince !== null &&
			now - runner.goneSince <= recentlyGoneMs,
	);

const units = ["B", "KB", "MB", "GB", "TB"];

export const formatBytes = (bytes: number): string => {
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	const shown =
		value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1);
	return `${shown} ${units[unit]}`;
};

/** "0.8 of 16.9 GB": the part in the whole's unit, so it fits the rail. */
export const formatShare = (part: number, whole: number): string => {
	let unit = 0;
	let scale = 1;
	while (whole / scale >= 1000 && unit < units.length - 1) {
		scale *= 1000;
		unit += 1;
	}
	const fixed = (value: number) =>
		unit === 0 || value / scale >= 100
			? String(Math.round(value / scale))
			: (value / scale).toFixed(1);
	return `${fixed(part)} of ${fixed(whole)} ${units[unit]}`;
};

export type Meter = { percent: number; value: string; extra: string };

const clamp = (percent: number) => Math.max(0, Math.min(100, percent));

export const meters = (
	runner: RunnerView,
): { cpu: Meter; memory: Meter; disk: Meter | null } | null => {
	const { usage } = runner;
	if (!usage) return null;
	const cpuPercent =
		usage.cpuPercent ??
		(usage.load1 !== null && usage.cpus > 0
			? (usage.load1 / usage.cpus) * 100
			: 0);
	const memPercent =
		usage.memTotal > 0 ? (usage.memUsed / usage.memTotal) * 100 : 0;
	const diskPercent =
		usage.diskTotal !== null && usage.diskFree !== null && usage.diskTotal > 0
			? clamp(((usage.diskTotal - usage.diskFree) / usage.diskTotal) * 100)
			: null;
	return {
		cpu: {
			percent: clamp(cpuPercent),
			value: `${Math.round(clamp(cpuPercent))}%`,
			extra:
				usage.load1 === null
					? `${usage.cpus} cores`
					: `load ${usage.load1.toFixed(1)} · ${usage.cpus} cores`,
		},
		memory: {
			percent: clamp(memPercent),
			value: `${Math.round(clamp(memPercent))}%`,
			extra: formatShare(usage.memUsed, usage.memTotal),
		},
		disk:
			diskPercent === null
				? null
				: {
						percent: diskPercent,
						value: `${Math.round(diskPercent)}%`,
						extra: `${formatBytes(usage.diskFree ?? 0)} free`,
					},
	};
};

export const sessionsMeter = (runner: RunnerView): Meter => ({
	percent:
		runner.cap > 0 ? clamp((runner.sessions.length / runner.cap) * 100) : 0,
	value: `${runner.sessions.length}/${runner.cap}`,
	extra:
		runner.sessions.length === 1
			? "1 session"
			: `${runner.sessions.length} sessions`,
});

const idleWords = (seconds: number): string =>
	seconds < 60
		? `idle ${seconds}s`
		: seconds < 3600
			? `idle ${Math.floor(seconds / 60)}m`
			: `idle ${Math.floor(seconds / 3600)}h`;

/** "Battery 62% · lid closed · idle 4m · hot": what a machine says of itself, unknowns left out. */
export const signalWords = (runner: RunnerView): string | null => {
	const signals = runner.signals;
	if (!signals) return null;
	const words = [
		signals.power === "battery"
			? `Battery${signals.batteryPercent === null ? "" : ` ${Math.round(signals.batteryPercent)}%`}`
			: signals.power === "mains"
				? "Mains"
				: null,
		signals.lidOpen === false ? "lid closed" : null,
		signals.idleSeconds === null ? null : idleWords(signals.idleSeconds),
		signals.thermal === "throttled" ? "hot" : null,
		signals.sleepMinutes === 0 ? "never sleeps" : null,
	].filter((word) => word !== null);
	return words.length > 0 ? words.join(" · ") : null;
};
