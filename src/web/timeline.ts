import type { Activity, Session, Task } from "../shared/types.ts";

export type SpanKind = "done" | "active" | "planned";

export type Span = {
	start: number;
	end: number;
	kind: SpanKind;
	title?: string;
};

export type Lane = {
	key: string;
	label: string;
	spans: Span[];
	finish: number | null;
	ticks: number[];
};

export type Window = { start: number; end: number };

const minute = 60_000;
export const lookBehindMs = 3 * 60 * minute;
const lookAheadMs = 20 * minute;

const projecting: readonly Activity[] = ["working", "needs-you", "watching"];

const byEnd = (a: Task, b: Task) => (a.endedAt ?? 0) - (b.endedAt ?? 0);

export function finishedSpans(tasks: readonly Task[]): Map<string, Span> {
	const spans = new Map<string, Span>();
	let previousEnd = Number.NEGATIVE_INFINITY;
	for (const task of tasks.filter((t) => t.endedAt !== null).sort(byEnd)) {
		const end = task.endedAt ?? 0;
		const start = Math.min(
			end,
			Math.max(task.startedAt ?? task.createdAt, previousEnd),
		);
		spans.set(task.id, { start, end, kind: "done" });
		previousEnd = end;
	}
	return spans;
}

export function taskDurations(tasks: readonly Task[]): number[] {
	return [...finishedSpans(tasks).values()]
		.map((span) => span.end - span.start)
		.filter((ms) => ms > 0);
}

export function averageTaskMs(sessions: readonly Session[]): number | null {
	const durations = sessions.flatMap((session) => taskDurations(session.tasks));
	if (durations.length === 0) return null;
	return durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
}

export function planOf(
	session: Session,
	now: number,
	fallbackMs: number | null,
): Map<string, Span> {
	const spans = finishedSpans(session.tasks);
	const own = averageTaskMs([session]);
	const typical = own ?? fallbackMs;
	const projects = projecting.includes(session.activity);
	let cursor = now;
	for (const task of session.tasks) {
		if (task.status !== "in_progress") continue;
		const start = Math.min(task.startedAt ?? now, now);
		const end =
			projects && typical !== null ? Math.max(now, start + typical) : now;
		spans.set(task.id, { start, end, kind: "active" });
		cursor = Math.max(cursor, end);
	}
	if (projects && typical !== null) {
		for (const task of session.tasks) {
			if (task.status !== "pending") continue;
			spans.set(task.id, {
				start: cursor,
				end: cursor + typical,
				kind: "planned",
			});
			cursor += typical;
		}
	}
	return spans;
}

export function finishOf(
	session: Session,
	spans: ReadonlyMap<string, Span>,
): number | null {
	const open = session.tasks.filter((task) => task.status !== "completed");
	if (open.length === 0 || !projecting.includes(session.activity)) return null;
	const ends = open.map((task) => spans.get(task.id));
	if (ends.some((span) => span === undefined)) return null;
	return Math.max(...ends.map((span) => span?.end ?? 0));
}

export function sessionLane(
	session: Session,
	label: string,
	now: number,
	fallbackMs: number | null,
): Lane {
	const spans = planOf(session, now, fallbackMs);
	return {
		key: session.id,
		label,
		spans: session.tasks.flatMap((task) => {
			const span = spans.get(task.id);
			return span ? [{ ...span, title: task.subject }] : [];
		}),
		finish: finishOf(session, spans),
		ticks: [],
	};
}

export function windowOf(lanes: readonly Lane[], now: number): Window {
	const times = lanes.flatMap((lane) => [
		...lane.spans.flatMap((span) => [span.start, span.end]),
		...lane.ticks,
		...(lane.finish === null ? [] : [lane.finish]),
	]);
	const start = Math.max(now - lookBehindMs, Math.min(now, ...times));
	return {
		start: Math.floor((start - 5 * minute) / (15 * minute)) * 15 * minute,
		end: Math.max(now, ...times) + lookAheadMs,
	};
}

export function minutesBetween(from: number, to: number): number {
	return (to - from) / minute;
}

export function marksOf(window: Window): number[] {
	const step =
		minutesBetween(window.start, window.end) > 4 * 60
			? 60 * minute
			: 15 * minute;
	const first = Math.ceil(window.start / step) * step;
	const marks: number[] = [];
	for (let at = first; at <= window.end; at += step) marks.push(at);
	return marks;
}

export function latestFinish(lanes: readonly Lane[]): number | null {
	const finishes = lanes.flatMap((lane) =>
		lane.finish === null ? [] : [lane.finish],
	);
	return finishes.length > 0 ? Math.max(...finishes) : null;
}
