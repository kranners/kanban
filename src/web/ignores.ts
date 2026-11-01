import type { ProjectIgnores } from "../shared/ignores.ts";
import type { Session } from "../shared/types.ts";
import { belongsTo } from "./placement.ts";

export type Ignore = { cwd: string; until: number };

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;

export type IgnoreDuration = { label: string; until: (at: number) => number };

const lasting =
	(ms: number) =>
	(at: number): number =>
		at + ms;

/** The next 9am in local time strictly after `at`: today's if it's still to come, else tomorrow's. */
export function nextMorning(at: number): number {
	const morning = new Date(at);
	morning.setHours(9, 0, 0, 0);
	if (morning.getTime() <= at) morning.setDate(morning.getDate() + 1);
	return morning.getTime();
}

export const untilTomorrow: IgnoreDuration = {
	label: "Until tomorrow",
	until: nextMorning,
};

export const quickIgnore = untilTomorrow;

export const ignoreDurations: readonly IgnoreDuration[] = [
	{ label: "30 minutes", until: lasting(30 * minute) },
	{ label: "1 hour", until: lasting(hour) },
	{ label: "4 hours", until: lasting(4 * hour) },
	untilTomorrow,
	{ label: "1 day", until: lasting(day) },
	{ label: "1 week", until: lasting(7 * day) },
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
