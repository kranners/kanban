// Cheap machine and process readings for runner heartbeats, using only Node's
// built-ins plus `vm_stat` on macOS and `ps` on macOS and Linux. The hub uses
// the same sampler for its own machine ("This Mac").
import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import type { RunnerUsage } from "../shared/runners.ts";

type CpuTimes = { idle: number; total: number };

const cpuTimes = (): CpuTimes => {
	let idle = 0;
	let total = 0;
	for (const cpu of cpus()) {
		const { user, nice, sys, idle: free, irq } = cpu.times;
		idle += free;
		total += user + nice + sys + free + irq;
	}
	return { idle, total };
};

export const busyPercent = (from: CpuTimes, to: CpuTimes): number | null => {
	const total = to.total - from.total;
	if (total <= 0) return null;
	const busy = total - (to.idle - from.idle);
	return Math.max(0, Math.min(100, (busy / total) * 100));
};

// Linux: MemAvailable counts reclaimable cache, unlike os.freemem's MemFree.
export const availableFromMeminfo = (text: string): number | null => {
	const match = text.match(/^MemAvailable:\s+(\d+)\s+kB/m);
	return match?.[1] ? Number(match[1]) * 1024 : null;
};

// macOS: free, inactive, speculative and purgeable pages are all available.
export const availableFromVmStat = (text: string): number | null => {
	const size = Number(text.match(/page size of (\d+) bytes/)?.[1]);
	if (!Number.isFinite(size) || size <= 0) return null;
	const pages = (label: string) =>
		Number(
			text.match(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m"))?.[1] ?? 0,
		);
	const total =
		pages("free") +
		pages("inactive") +
		pages("speculative") +
		pages("purgeable");
	return total > 0 ? total * size : null;
};

const run = (file: string, args: string[]): Promise<string | null> =>
	new Promise((resolve) => {
		execFile(file, args, { timeout: 3_000 }, (error, stdout) =>
			resolve(error ? null : stdout),
		);
	});

const availableMemory = async (platform: NodeJS.Platform): Promise<number> => {
	if (platform === "linux") {
		const text = await readFile("/proc/meminfo", "utf8").catch(() => null);
		const available = text ? availableFromMeminfo(text) : null;
		if (available !== null) return available;
	}
	if (platform === "darwin") {
		const text = await run("vm_stat", []);
		const available = text ? availableFromVmStat(text) : null;
		if (available !== null) return available;
	}
	return freemem();
};

const disk = async (
	path: string,
): Promise<{ diskTotal: number | null; diskFree: number | null }> => {
	try {
		const stats = await statfs(path);
		return {
			diskTotal: stats.blocks * stats.bsize,
			diskFree: stats.bavail * stats.bsize,
		};
	} catch {
		return { diskTotal: null, diskFree: null };
	}
};

export type UsageSampler = () => Promise<RunnerUsage>;

export const createUsageSampler = (
	platform: NodeJS.Platform = process.platform,
	diskPath: string = homedir(),
): UsageSampler => {
	let previous = cpuTimes();
	return async () => {
		const times = cpuTimes();
		const cpuPercent = busyPercent(previous, times);
		previous = times;
		const memTotal = totalmem();
		const available = await availableMemory(platform);
		return {
			cpus: cpus().length,
			cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent),
			load1:
				platform === "win32"
					? null
					: Math.round((loadavg()[0] ?? 0) * 100) / 100,
			memTotal,
			memUsed: Math.max(0, memTotal - available),
			...(await disk(diskPath)),
		};
	};
};

export type ProcessStat = { cpuPercent: number; rss: number };

export const parsePs = (text: string): Map<number, ProcessStat> => {
	const stats = new Map<number, ProcessStat>();
	for (const line of text.split("\n")) {
		const [pid, cpu, rss] = line.trim().split(/\s+/).map(Number);
		if (
			pid !== undefined &&
			cpu !== undefined &&
			rss !== undefined &&
			Number.isInteger(pid) &&
			Number.isFinite(cpu) &&
			Number.isFinite(rss)
		) {
			stats.set(pid, { cpuPercent: cpu, rss: rss * 1024 });
		}
	}
	return stats;
};

// Per-process CPU and memory from one `ps` call. Windows has no cheap
// equivalent, so sessions there report none.
export const processStats = async (
	pids: readonly number[],
	platform: NodeJS.Platform = process.platform,
): Promise<Map<number, ProcessStat>> => {
	if (pids.length === 0 || platform === "win32") return new Map();
	const text = await run("ps", ["-o", "pid=,%cpu=,rss=", "-p", pids.join(",")]);
	return text ? parsePs(text) : new Map();
};
