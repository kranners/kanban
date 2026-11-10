// Where the hub would have placed a launch, from what each machine reports.
// It only answers the question: every launch still goes exactly where it was
// asked, and this is logged beside it so the rules can be judged on real
// launches before anything acts on them.
import { basename, join } from "node:path";
import type {
	RunnerCheckout,
	RunnerSignals,
	RunnerView,
} from "../shared/runners.ts";
import type { RunnerDropRecord } from "./runnerDrops.ts";

export type PlacementCandidate = {
	view: RunnerView;
	/** The full signals, checkouts included; null from a runner too old to send them. */
	signals: RunnerSignals | null;
};

export type PlacementVerdict = {
	runsOn: string;
	label: string;
	fits: boolean;
	/** Why it doesn't fit, or what it has going for it. */
	reasons: string[];
	score: number;
};

export type WouldPlace = {
	/** The machine it would have chosen, or null when none fits. */
	runsOn: string | null;
	label: string | null;
	reason: string;
	verdicts: PlacementVerdict[];
};

/** The off-switch: while this file exists in the board's state folder, nothing is logged. */
export const wouldPlaceOffFile = (stateDir: string) =>
	join(stateDir, "would-place.off");

export const minFreeBytes = 2 * 1024 ** 3;
export const atKeyboardSeconds = 120;
export const maxLoadPerCpu = 1;

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export const normalizeRemote = (remote: string): string =>
	remote
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?/i, "")
		.replace(/^[^@/]+@([^:/]+):/, "$1/")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "")
		.toLowerCase();

const within = (cwd: string, path: string) =>
	cwd === path || cwd.startsWith(`${path}/`);

/** The checkout a folder belongs to on the machine it was asked of, if it reported one. */
const checkoutFor = (
	cwd: string,
	checkouts: readonly RunnerCheckout[],
): RunnerCheckout | null =>
	[...checkouts]
		.filter((checkout) => within(cwd, checkout.path))
		.sort((a, b) => b.path.length - a.path.length)[0] ?? null;

const hasCheckout = (
	cwd: string,
	wanted: RunnerCheckout | null,
	checkouts: readonly RunnerCheckout[],
): boolean => {
	if (wanted?.remote) {
		const remote = normalizeRemote(wanted.remote);
		return checkouts.some(
			(checkout) =>
				checkout.remote !== null && normalizeRemote(checkout.remote) === remote,
		);
	}
	const name = basename(wanted?.path ?? cwd);
	return checkouts.some((checkout) => basename(checkout.path) === name);
};

export const wouldPlace = (
	launch: { cwd: string; runsOn: string },
	candidates: readonly PlacementCandidate[],
): WouldPlace => {
	const asked = candidates.find(
		(candidate) => candidate.view.runsOn === launch.runsOn,
	);
	const wanted = asked?.signals
		? checkoutFor(launch.cwd, asked.signals.checkouts)
		: null;
	const platform = asked?.view.platform ?? null;
	const repo = basename(wanted?.path ?? launch.cwd);

	const verdicts = candidates.map(({ view, signals }): PlacementVerdict => {
		const against: string[] = [];
		const usage = view.usage;
		if (view.state !== "online")
			against.push(view.state === "asleep" ? "asleep" : "offline");
		if (view.sessions.length >= view.cap && view.cap > 0)
			against.push(`at its cap (${view.sessions.length} of ${view.cap})`);
		if (platform && view.platform && view.platform !== platform)
			against.push(`runs ${view.platform}, not ${platform}`);
		if (!signals) against.push("reports no placement signals");
		else {
			if (!hasCheckout(launch.cwd, wanted, signals.checkouts))
				against.push(`has no checkout of ${repo}`);
			if (signals.power === "battery")
				against.push(
					`on battery${signals.batteryPercent === null ? "" : ` (${signals.batteryPercent}%)`}`,
				);
			if (signals.lidOpen === false) against.push("lid closed");
			if (signals.thermal === "throttled") against.push("running hot");
			if (
				signals.idleSeconds !== null &&
				signals.idleSeconds < atKeyboardSeconds
			)
				against.push(`someone was at the keyboard ${signals.idleSeconds}s ago`);
		}
		const free = usage ? usage.memTotal - usage.memUsed : null;
		if (usage && free !== null && free < minFreeBytes)
			against.push(`only ${gb(free)} free`);
		const loadPerCpu =
			usage?.load1 !== null && usage?.load1 !== undefined && usage.cpus > 0
				? usage.load1 / usage.cpus
				: null;
		if (loadPerCpu !== null && loadPerCpu >= maxLoadPerCpu)
			against.push(`load ${usage?.load1?.toFixed(1)} on ${usage?.cpus} cores`);
		const score =
			(free ?? 0) / 1024 ** 3 -
			(loadPerCpu ?? 0) * 8 +
			(view.runsOn === launch.runsOn ? 0.5 : 0);
		const fits = against.length === 0 && usage !== null;
		return {
			runsOn: view.runsOn,
			label: view.label,
			fits,
			reasons: fits
				? [
						`has ${repo}`,
						free === null ? "memory unknown" : `${gb(free)} free`,
						usage?.load1 === null || usage?.load1 === undefined
							? "load unknown"
							: `load ${usage.load1.toFixed(1)}`,
					]
				: against.length > 0
					? against
					: ["reports no usage"],
			score,
		};
	});

	const best = verdicts
		.filter((verdict) => verdict.fits)
		.sort((a, b) => b.score - a.score)[0];
	const others = verdicts
		.filter((verdict) => verdict !== best && !verdict.fits)
		.map((verdict) => `${verdict.label} ${verdict.reasons.join(", ")}`);
	if (!best) {
		return {
			runsOn: null,
			label: null,
			reason: `no machine fits: ${others.join("; ") || "no machines known"}`,
			verdicts,
		};
	}
	return {
		runsOn: best.runsOn,
		label: best.label,
		reason: `${best.label} ${best.reasons.join(", ")}${others.length > 0 ? `; ${others.join("; ")}` : ""}`,
		verdicts,
	};
};

export type WouldPlaceEntry = {
	at: number;
	launchId: string | null;
	cwd: string;
	went: string;
	wouldGo: string | null;
	reason: string;
};

export type PlacementLog = {
	/** Logs where a launch would have gone, unless the off-switch file exists. */
	record(
		launch: { id: string | null; cwd: string; runsOn: string; label: string },
		candidates: readonly PlacementCandidate[],
	): WouldPlaceEntry | null;
	enabled(): boolean;
	recent(): WouldPlaceEntry[];
};

export const keptPlacements = 100;

export const createPlacementLog = ({
	off,
	log = console.log,
	now = Date.now,
}: {
	/** True while the off-switch is set; checked at every launch. */
	off: () => boolean;
	log?: (line: string) => void;
	now?: () => number;
}): PlacementLog => {
	let entries: WouldPlaceEntry[] = [];
	return {
		enabled: () => !off(),
		recent: () => [...entries],
		record(launch, candidates) {
			if (off()) return null;
			const choice = wouldPlace(launch, candidates);
			const entry: WouldPlaceEntry = {
				at: now(),
				launchId: launch.id,
				cwd: launch.cwd,
				went: launch.label,
				wouldGo: choice.label,
				reason: choice.reason,
			};
			entries = [entry, ...entries].slice(0, keptPlacements);
			log(
				`would-place: launch ${launch.id ?? "(refused)"} went to ${launch.label}, would have gone to ${choice.label ?? "nowhere"}: ${choice.reason}`,
			);
			return entry;
		},
	};
};

export type PlacementReport = {
	wouldPlace: {
		enabled: boolean;
		/** Create this file to turn the would-place log off. */
		offFile: string;
		recent: WouldPlaceEntry[];
	};
	runners: (Pick<
		RunnerView,
		"id" | "label" | "runsOn" | "state" | "platform" | "lastSeen" | "usage"
	> & {
		signals: RunnerSignals | null;
		drops: RunnerDropRecord | null;
	})[];
};

export const placementReport = (
	candidates: readonly PlacementCandidate[],
	drops: Record<string, RunnerDropRecord>,
	log: PlacementLog,
	offFile: string,
): PlacementReport => ({
	wouldPlace: { enabled: log.enabled(), offFile, recent: log.recent() },
	runners: candidates.map(({ view, signals }) => ({
		id: view.id,
		label: view.label,
		runsOn: view.runsOn,
		state: view.state,
		platform: view.platform,
		lastSeen: view.lastSeen,
		usage: view.usage,
		signals,
		drops: drops[view.id] ?? null,
	})),
});
