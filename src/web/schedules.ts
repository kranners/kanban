import { signal } from "@preact/signals";
import type {
	Point,
	Schedule,
	ScheduleDraft,
	ScheduleMode,
} from "../shared/types.ts";

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

export type ScheduleDialogState = { at?: Point };

export type ReportReady = { scheduleId: string; noteId: string; at: number };

export const schedules = signal<Schedule[] | null>(null);
export const scheduleDialog = signal<ScheduleDialogState | null>(null);
export const reportsReady = signal<readonly ReportReady[]>([]);

export const modeLabel: Record<ScheduleMode, string> = {
	replace: "Replace the last report",
	stack: "Add a new note each time",
};

export const freshReports = (
	previous: readonly Schedule[] | null,
	next: readonly Schedule[],
): ReportReady[] => {
	if (previous === null) return [];
	const seen = new Map(previous.map((s) => [s.id, s.reportedAt]));
	return next.flatMap((s) =>
		s.reportedAt !== null &&
		s.noteId !== null &&
		s.reportedAt !== seen.get(s.id)
			? [{ scheduleId: s.id, noteId: s.noteId, at: s.reportedAt }]
			: [],
	);
};

export const when = (at: number, now: number): string => {
	const day = new Date(at);
	const today = new Date(now);
	const time = [day.getHours(), day.getMinutes()]
		.map((part) => String(part).padStart(2, "0"))
		.join(":");
	if (day.toDateString() === today.toDateString()) return `today ${time}`;
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	if (day.toDateString() === tomorrow.toDateString()) {
		return `tomorrow ${time}`;
	}
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (day.toDateString() === yesterday.toDateString()) {
		return `yesterday ${time}`;
	}
	return `${day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
};

export const scheduleStatus = (schedule: Schedule, now: number): string => {
	if (schedule.run) return "Writing the report now";
	return schedule.reportedAt === null
		? "No report yet"
		: `Last report ${when(schedule.reportedAt, now)}`;
};

export const headlineOf = (text: string): string =>
	text
		.split("\n")
		.slice(1)
		.map((line) =>
			line
				.replace(/^(?:[#>+-]|\*\s|\s)+/, "")
				.replace(/\*\*(.+?)\*\*/g, "$1")
				.replaceAll("`", "")
				.trim(),
		)
		.filter(Boolean)
		.slice(0, 2)
		.join(" · ") || "It is on the board";

export const promptPreview = (prompt: string): string => {
	const line = prompt.trim().split("\n")[0] ?? "";
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<Outcome<T>> {
	try {
		const response = await fetch(path, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		if (response.status === 204) return { ok: true, value: undefined as T };
		const parsed = (await response.json().catch(() => null)) as
			| (T & { error?: string })
			| null;
		if (response.ok && parsed) return { ok: true, value: parsed };
		return {
			ok: false,
			error:
				parsed?.error ?? `The board server answered HTTP ${response.status}`,
		};
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

const schedulePath = (id: string) => `/api/schedules/${encodeURIComponent(id)}`;

export const createSchedule = (draft: ScheduleDraft) =>
	request<Schedule>("POST", "/api/schedules", draft);

export const updateSchedule = (id: string, patch: Partial<ScheduleDraft>) =>
	request<Schedule>("PATCH", schedulePath(id), patch);

export const deleteSchedule = (id: string) =>
	request<undefined>("DELETE", schedulePath(id));

export const runSchedule = (id: string) =>
	request<{ ok: true }>("POST", `${schedulePath(id)}/run`);

export function dismissReport(scheduleId: string): void {
	reportsReady.value = reportsReady
		.peek()
		.filter((ready) => ready.scheduleId !== scheduleId);
}

export function receiveSchedules(
	next: Schedule[],
	announce: (ready: ReportReady) => void,
): void {
	const fresh = freshReports(schedules.peek(), next);
	schedules.value = next;
	if (fresh.length === 0) return;
	const ids = new Set(fresh.map((ready) => ready.scheduleId));
	reportsReady.value = [
		...fresh,
		...reportsReady.peek().filter((ready) => !ids.has(ready.scheduleId)),
	];
	for (const ready of fresh) announce(ready);
}
