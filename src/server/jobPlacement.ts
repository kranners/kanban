// Where the hub sends a queued job: a runner that is online, lists the class in
// its own config and has room. A personal job never goes to a runner the hub is
// told takes plain work only, whatever that runner's config says. A runner just
// back takes short work at once and long work after a minute of steady
// heartbeats, and long work goes to the runner that usually stays up longest at
// this hour, from the hub's record of its drops.
import type { RunnerJobsReport } from "../shared/runners.ts";
import type { RunnerDropRecord } from "./runnerDrops.ts";

export const shortJobMs = 60_000;
export const steadyAfterMs = 60_000;

export type JobCandidate = {
	id: string;
	online: boolean;
	onlineSince: number | null;
	jobs: RunnerJobsReport | null;
	plainOnly: boolean;
	/** Proved itself with its own enrolled secret; only such a runner takes personal work. */
	enrolled: boolean;
	loadPerCpu: number | null;
	drops: RunnerDropRecord | null;
};

export type JobToPlace = {
	class: string;
	personal: boolean;
	expectedMs: number;
	excluded: readonly string[];
};

export type JobPlacement =
	| { runner: string; reason: string }
	| { runner: null; reason: string };

/** How long the runner usually stays up at this hour, from its drops then; Infinity when it never dropped. */
export const usualUpMs = (
	drops: RunnerDropRecord | null,
	at: number,
	hour: number,
): number => {
	if (!drops) return Number.POSITIVE_INFINITY;
	const days = Math.max(1, (at - drops.since) / 86_400_000);
	const perHour = (drops.byHour[hour] ?? 0) / days;
	return perHour === 0 ? Number.POSITIVE_INFINITY : 3_600_000 / perHour;
};

export const placeJob = (
	job: JobToPlace,
	candidates: readonly JobCandidate[],
	at: number,
	hour: number = new Date(at).getHours(),
): JobPlacement => {
	const why: string[] = [];
	const fit = candidates.filter((candidate) => {
		const refuse = (reason: string) => {
			why.push(`${candidate.id} ${reason}`);
			return false;
		};
		if (!candidate.online) return refuse("is offline");
		if (!candidate.jobs) return refuse("runs a runner too old for jobs");
		const listed = candidate.jobs.classes.find(
			(known) => known.name === job.class,
		);
		if (!listed) return refuse(`doesn't list ${job.class}`);
		if (candidate.plainOnly && (job.personal || listed.personal)) {
			return refuse("takes plain work only");
		}
		if ((job.personal || listed.personal) && !candidate.enrolled) {
			return refuse("hasn't enrolled its own secret, so takes plain work only");
		}
		if (job.excluded.includes(candidate.id)) return refuse("refused it before");
		if (candidate.jobs.refusing)
			return refuse(`is refusing: ${candidate.jobs.refusing}`);
		if (candidate.jobs.slotsFree < 1) return refuse("has no free slot");
		if (
			job.expectedMs > shortJobMs &&
			(candidate.onlineSince === null ||
				at - candidate.onlineSince < steadyAfterMs)
		) {
			return refuse("is just back, so takes short work only for a minute");
		}
		return true;
	});
	if (fit.length === 0) {
		return { runner: null, reason: why.join("; ") || "no runner is known" };
	}
	const ranked = fit
		.map((candidate) => ({
			candidate,
			up: usualUpMs(candidate.drops, at, hour),
		}))
		.sort(
			(a, b) =>
				(job.expectedMs > shortJobMs ? b.up - a.up : 0) ||
				(b.candidate.jobs?.slotsFree ?? 0) -
					(a.candidate.jobs?.slotsFree ?? 0) ||
				(a.candidate.loadPerCpu ?? 1) - (b.candidate.loadPerCpu ?? 1) ||
				a.candidate.id.localeCompare(b.candidate.id),
		);
	const [best] = ranked;
	if (!best) return { runner: null, reason: "no runner is known" };
	if (job.expectedMs > shortJobMs && job.expectedMs > best.up) {
		return {
			runner: null,
			reason: `no runner usually stays up ${Math.round(job.expectedMs / 60_000)} minutes at ${hour}:00`,
		};
	}
	return {
		runner: best.candidate.id,
		reason:
			job.expectedMs > shortJobMs && Number.isFinite(best.up)
				? `steadiest at ${hour}:00, up about ${Math.round(best.up / 60_000)} minutes between drops`
				: "has room",
	};
};
