import type { ProjectIgnores } from "../shared/ignores.ts";
import type { Session } from "../shared/types.ts";
import { belongsTo } from "./placement.ts";

export type Ignore = { cwd: string; until: number };

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;

export const quickIgnoreMs = day;

export const ignoreDurations: readonly { label: string; ms: number }[] = [
	{ label: "30 minutes", ms: 30 * minute },
	{ label: "1 hour", ms: hour },
	{ label: "4 hours", ms: 4 * hour },
	{ label: "1 day", ms: day },
	{ label: "1 week", ms: 7 * day },
];

export function ignoreOf(
	ignores: ProjectIgnores,
	cwd: string,
	at: number,
): Ignore | null {
	return Object.entries(ignores).reduce<Ignore | null>(
		(latest, [root, until]) =>
			until > at &&
			belongsTo({ cwd: root }, cwd) &&
			(latest === null || until > latest.until)
				? { cwd: root, until }
				: latest,
		null,
	);
}

export function ignoredSessionIds(
	ignores: ProjectIgnores,
	sessions: readonly Session[],
	at: number,
): Set<string> {
	return new Set(
		sessions.flatMap((s) => (ignoreOf(ignores, s.cwd, at) ? [s.id] : [])),
	);
}

export function ignoredUntilLabel(until: number, at: number): string {
	const time = new Date(until);
	const clock = time.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
	if (until - at < day && time.getDate() === new Date(at).getDate())
		return clock;
	const date = time.toLocaleDateString([], {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
	return `${date}, ${clock}`;
}
