// A small, lasting record of when each runner drops off and why, built from
// the heartbeats the hub already gets: each silence past offlineAfterMs is a
// drop, counted by the hub's hour of day, with what the machine last said of
// its power and lid, and closed when it comes back as the same boot (sleep or
// network) or a reboot. Kept in a file so a hub restart keeps the history.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RunnerSignals } from "../shared/runners.ts";

export type DropCause = "same-boot" | "rebooted";

export type Drop = {
	at: number;
	hour: number;
	bootedAt: number;
	power: RunnerSignals["power"];
	batteryPercent: number | null;
	lidOpen: boolean | null;
	idleSeconds: number | null;
	backAt: number | null;
	cause: DropCause | null;
};

export type RunnerDropRecord = {
	since: number;
	/** Drops by the hour of day they started, 0-23, in the hub's time zone. */
	byHour: number[];
	total: number;
	recent: Drop[];
};

export type DropStore = Record<string, RunnerDropRecord>;

export const recentDrops = 50;
const bootSlackMs = 2 * 60_000;

const blank = (since: number): RunnerDropRecord => ({
	since,
	byHour: Array.from({ length: 24 }, () => 0),
	total: 0,
	recent: [],
});

export type DropRecorder = {
	gone(
		id: string,
		at: number,
		bootedAt: number,
		signals: RunnerSignals | undefined,
	): void;
	/** Closes an open drop; true when there was one. */
	back(id: string, at: number, bootedAt: number): boolean;
	seen(id: string, at: number): void;
	records(): DropStore;
};

export const createDropRecorder = ({
	load = () => ({}),
	save = () => {},
	hourOf = (at) => new Date(at).getHours(),
}: {
	load?: () => DropStore;
	save?: (store: DropStore) => void;
	hourOf?: (at: number) => number;
} = {}): DropRecorder => {
	const store: DropStore = load();
	const recordOf = (id: string, at: number) => {
		store[id] ??= blank(at);
		return store[id];
	};
	return {
		seen(id, at) {
			if (store[id]) return;
			recordOf(id, at);
			save(store);
		},
		gone(id, at, bootedAt, signals) {
			const record = recordOf(id, at);
			const hour = hourOf(at);
			record.byHour[hour] = (record.byHour[hour] ?? 0) + 1;
			record.total += 1;
			record.recent = [
				{
					at,
					hour,
					bootedAt,
					power: signals?.power ?? null,
					batteryPercent: signals?.batteryPercent ?? null,
					lidOpen: signals?.lidOpen ?? null,
					idleSeconds: signals?.idleSeconds ?? null,
					backAt: null,
					cause: null,
				},
				...record.recent,
			].slice(0, recentDrops);
			save(store);
		},
		back(id, at, bootedAt) {
			const open = store[id]?.recent.find((drop) => drop.backAt === null);
			if (!open) return false;
			open.backAt = at;
			open.cause =
				Math.abs(bootedAt - open.bootedAt) <= bootSlackMs
					? "same-boot"
					: "rebooted";
			save(store);
			return true;
		},
		records: () => structuredClone(store),
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const parseDropStore = (text: string): DropStore => {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return {};
	}
	if (!isRecord(body)) return {};
	const store: DropStore = {};
	for (const [id, value] of Object.entries(body)) {
		if (
			!isRecord(value) ||
			typeof value.since !== "number" ||
			!Array.isArray(value.byHour) ||
			value.byHour.length !== 24 ||
			!value.byHour.every((count) => typeof count === "number") ||
			typeof value.total !== "number" ||
			!Array.isArray(value.recent)
		)
			continue;
		store[id] = {
			since: value.since,
			byHour: value.byHour as number[],
			total: value.total,
			recent: (value.recent as Drop[])
				.filter((drop) => isRecord(drop) && typeof drop.at === "number")
				.slice(0, recentDrops),
		};
	}
	return store;
};

export const dropFile = (file: string) => ({
	load: (): DropStore => {
		try {
			return parseDropStore(readFileSync(file, "utf8"));
		} catch {
			return {};
		}
	},
	save: (store: DropStore) => {
		try {
			writeFileSync(`${file}.tmp`, JSON.stringify(store));
			renameSync(`${file}.tmp`, file);
		} catch {}
	},
});
