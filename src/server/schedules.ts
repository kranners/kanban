import { randomUUID } from "node:crypto";
import {
	isScheduleTime,
	lastSlotAtOrBefore,
	maxHistoryDays,
	maxSchedulePrompt,
	maxSchedules,
} from "../shared/schedules.ts";
import {
	type Annotations,
	type CommentThread,
	maxNoteText,
	type Note,
	type Schedule,
	type ScheduleDraft,
	type ScheduleMode,
	type ScheduleRun,
	scheduleModes,
} from "../shared/types.ts";
import { gridSize, snap } from "../web/grid.ts";
import { clearOf, noteSizeFor, topZ } from "../web/notes.ts";
import type { Rect } from "../web/placement.ts";
import type { AnnotationStore } from "./annotations.ts";
import type { Audit } from "./audit.ts";
import type { BoardAgent } from "./boardAgent.ts";
import { type CommentStore, maxThreads } from "./comments.ts";
import { asNumber, asObject, asString } from "./ingest/json.ts";
import { isCoordinate } from "./layout.ts";
import { createStateFile, readState } from "./stateFile.ts";

export const scheduleTickMs = 60_000;
const dayMs = 24 * 60 * 60_000;
const scheduleIdPattern = /^[A-Za-z0-9-]{1,64}$/;

export type SchedulePatch = Partial<ScheduleDraft>;

export type Started = { ok: true } | { error: string; status: 404 | 409 };

export type Scheduler = {
	current(): Schedule[];
	create(draft: ScheduleDraft): Schedule | null;
	update(id: string, patch: SchedulePatch): Schedule | null;
	remove(id: string): boolean;
	runNow(id: string): Started;
	tick(): void;
	observe(thread: CommentThread): void;
	stop(): void;
	saved(): Promise<void>;
};

export type SchedulerDeps = {
	file: string;
	initial: Schedule[];
	onChange: (schedules: Schedule[]) => void;
	comments: CommentStore;
	agent: Pick<BoardAgent, "ask" | "cancel">;
	annotations: AnnotationStore;
	occupied: () => Rect[];
	audit: Audit;
	now?: () => number;
	newId?: () => string;
};

export const isScheduleId = (value: string): boolean =>
	scheduleIdPattern.test(value);

const isMode = (value: unknown): value is ScheduleMode =>
	scheduleModes.includes(value as ScheduleMode);

const promptError = `prompt must be between 1 and ${maxSchedulePrompt} characters`;

const isPrompt = (value: unknown): value is string =>
	typeof value === "string" &&
	value.trim() !== "" &&
	value.length <= maxSchedulePrompt;

const fieldError = (fields: Record<string, unknown>): string | null => {
	if (fields.time !== undefined && !isScheduleTime(fields.time)) {
		return "time must be HH:MM on a 24-hour clock";
	}
	if (fields.prompt !== undefined && !isPrompt(fields.prompt)) {
		return promptError;
	}
	if (
		(fields.x !== undefined && !isCoordinate(fields.x)) ||
		(fields.y !== undefined && !isCoordinate(fields.y))
	) {
		return "x and y must be finite board coordinates";
	}
	if (fields.mode !== undefined && !isMode(fields.mode)) {
		return "mode must be replace or stack";
	}
	return null;
};

export const parseScheduleDraft = (
	body: unknown,
): ScheduleDraft | { error: string } => {
	const fields = asObject(body);
	if (!fields) {
		return { error: "Expected a JSON object with time, prompt, x, y and mode" };
	}
	const { time, prompt, x, y, mode } = fields;
	if (
		time === undefined ||
		prompt === undefined ||
		x === undefined ||
		y === undefined ||
		mode === undefined
	) {
		return { error: "time, prompt, x, y and mode are required" };
	}
	const error = fieldError(fields);
	if (error) return { error };
	return {
		time: time as string,
		prompt: prompt as string,
		x: x as number,
		y: y as number,
		mode: mode as ScheduleMode,
	};
};

export const parseSchedulePatch = (
	body: unknown,
): SchedulePatch | { error: string } => {
	const fields = asObject(body);
	if (!fields) return { error: "Expected a JSON object" };
	const known = ["time", "prompt", "x", "y", "mode"];
	const unknown = Object.keys(fields).find((key) => !known.includes(key));
	if (unknown) return { error: `Unknown field ${unknown}` };
	if (Object.keys(fields).length === 0) return { error: "Nothing to change" };
	const error = fieldError(fields);
	return error ? { error } : (fields as SchedulePatch);
};

const parseRun = (value: unknown): ScheduleRun | null => {
	const run = asObject(value);
	const threadId = asString(run?.threadId);
	const startedAt = asNumber(run?.startedAt);
	if (!threadId || startedAt === null) return null;
	return { threadId, startedAt, slot: asNumber(run?.slot) };
};

const parseSchedule = (value: unknown): Schedule | null => {
	const fields = asObject(value);
	const id = asString(fields?.id);
	if (!fields || !id || !isScheduleId(id)) return null;
	const draft = parseScheduleDraft(fields);
	const createdAt = asNumber(fields.createdAt);
	if ("error" in draft || createdAt === null) return null;
	return {
		id,
		...draft,
		createdAt,
		lastSlot: asNumber(fields.lastSlot) ?? createdAt,
		lastRunAt: asNumber(fields.lastRunAt),
		lastError: asString(fields.lastError),
		threadId: asString(fields.threadId),
		run: parseRun(fields.run),
		noteId: asString(fields.noteId),
		reportedAt: asNumber(fields.reportedAt),
	};
};

export const parseSchedules = (value: unknown): Schedule[] => {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value
		.flatMap((raw) => {
			const schedule = parseSchedule(raw);
			if (!schedule || seen.has(schedule.id)) return [];
			seen.add(schedule.id);
			return [schedule];
		})
		.slice(0, maxSchedules);
};

export const loadSchedules = (file: string): Promise<Schedule[]> =>
	readState(file, parseSchedules);

const stamp = (at: number): string =>
	new Date(at).toLocaleString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

const zone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const noteBudget = maxNoteText - 1000;

export const reportPromptFor = (
	prompt: string,
	since: number,
	at: number,
): string =>
	[
		prompt.trim(),
		"",
		`The report covers ${new Date(since).toISOString()} to ${new Date(at).toISOString()} (${stamp(since)} to ${stamp(at)}, ${zone()}).`,
		`Start with board_history with since "${new Date(since).toISOString()}"; it includes sessions that have ended and left the board, and what reached each repository's main branch. Read transcripts or ask a session only when its history leaves something important unclear.`,
		`The board writes your final message into a note itself, so do not call put_note or change the board. Make your final message only the report, in GitHub-flavoured markdown, under ${noteBudget} characters, with no preamble.`,
	].join("\n");

const latestRun = (thread: CommentThread) => {
	const start = thread.events.findLastIndex((event) => event.kind === "user");
	const events = thread.events.slice(start + 1);
	return {
		reply: events.findLast((event) => event.kind === "reply")?.text ?? null,
		error: events.findLast((event) => event.kind === "error")?.text ?? null,
	};
};

const clipped = (text: string): string =>
	text.length > maxNoteText ? `${text.slice(0, maxNoteText - 1)}…` : text;

export const reportNoteText = (
	thread: CommentThread | null,
	startedAt: number,
): { text: string; error: string | null } => {
	const heading = `**Scheduled report · ${stamp(startedAt)}**`;
	const { reply, error } = thread
		? latestRun(thread)
		: { reply: null, error: "Its comment thread was deleted" };
	const failure =
		error ?? (reply === null ? "The board agent wrote no report" : null);
	const body = failure
		? `The report did not finish: ${failure}${reply ? `\n\n${reply}` : ""}`
		: (reply ?? "");
	return { text: clipped(`${heading}\n\n${body.trim()}`), error: failure };
};

const reportNote = (
	schedule: Schedule,
	text: string,
	annotations: Annotations,
	occupied: Rect[],
	newId: () => string,
): Note => {
	const previous = schedule.noteId ? annotations[schedule.noteId] : undefined;
	if (schedule.mode === "replace" && previous?.kind === "note") {
		return { ...previous, text };
	}
	return clearOf<Note>(
		{
			id: newId(),
			kind: "note",
			x: snap(schedule.x + gridSize * 2),
			y: snap(schedule.y),
			...noteSizeFor(text),
			z: topZ(annotations) + 1,
			text,
			color: "blue",
		},
		occupied,
	);
};

export const createScheduler = ({
	file,
	initial,
	onChange,
	comments,
	agent,
	annotations,
	occupied,
	audit,
	now = Date.now,
	newId = randomUUID,
}: SchedulerDeps): Scheduler => {
	let schedules = [...initial];
	let stopping = false;
	const stored = createStateFile<Schedule[]>(file);

	const commit = (next: Schedule[]) => {
		schedules = next;
		stored.write(schedules);
		onChange(schedules);
	};

	const find = (id: string) =>
		schedules.find((schedule) => schedule.id === id) ?? null;

	const change = (id: string, fields: Partial<Schedule>) => {
		commit(
			schedules.map((schedule) =>
				schedule.id === id ? { ...schedule, ...fields } : schedule,
			),
		);
	};

	const refuse = (
		schedule: Schedule,
		error: string,
		status: 404 | 409,
	): Started => {
		if (schedule.lastError !== error) {
			change(schedule.id, { lastError: error });
			audit({
				action: "scheduled-report",
				schedule: schedule.id,
				thread: null,
				result: `error: ${error}`,
			});
		}
		return { error, status };
	};

	const start = (schedule: Schedule, slot: number | null): Started => {
		const at = now();
		const thread = comments.create({
			x: schedule.x,
			y: schedule.y,
			text: schedule.prompt,
		});
		if (!thread) {
			return refuse(
				schedule,
				`The board holds at most ${maxThreads} comments`,
				409,
			);
		}
		const since = Math.max(
			schedule.lastRunAt ?? at - dayMs,
			at - maxHistoryDays * dayMs,
		);
		const asked = agent.ask(
			thread.id,
			reportPromptFor(schedule.prompt, since, at),
		);
		if ("error" in asked) {
			comments.remove(thread.id);
			return refuse(schedule, asked.error, asked.status);
		}
		if (schedule.threadId) {
			agent.cancel(schedule.threadId);
			comments.remove(schedule.threadId);
		}
		change(schedule.id, {
			lastSlot: slot ?? schedule.lastSlot,
			lastError: null,
			threadId: thread.id,
			run: { threadId: thread.id, startedAt: at, slot },
		});
		audit({
			action: "scheduled-report",
			schedule: schedule.id,
			thread: thread.id,
			result: "started",
		});
		return { ok: true };
	};

	const settle = (schedule: Schedule) => {
		const run = schedule.run;
		if (!run) return;
		const thread = comments.get(run.threadId);
		if (thread?.running) return;
		const { text, error } = reportNoteText(thread, run.startedAt);
		const note = reportNote(
			schedule,
			text,
			annotations.current(),
			occupied(),
			newId,
		);
		const put = annotations.put(note);
		const failure = "error" in put ? put.error : error;
		change(schedule.id, {
			run: null,
			lastError: failure,
			...("error" in put ? {} : { noteId: note.id, reportedAt: now() }),
			...(failure ? {} : { lastRunAt: run.startedAt }),
		});
		audit({
			action: "scheduled-report",
			schedule: schedule.id,
			thread: run.threadId,
			result: failure ? `error: ${failure}` : "noted",
		});
	};

	for (const schedule of schedules) {
		const run = schedule.run;
		if (!run) continue;
		comments.remove(run.threadId);
		change(schedule.id, {
			run: null,
			threadId: null,
			lastError: "The board restarted during the report, so it runs again",
			lastSlot: (run.slot ?? lastSlotAtOrBefore(now(), schedule.time)) - 1,
		});
	}

	return {
		current: () => schedules,
		create(draft) {
			if (schedules.length >= maxSchedules) return null;
			const at = now();
			const schedule: Schedule = {
				id: newId(),
				...draft,
				createdAt: at,
				lastSlot: at,
				lastRunAt: null,
				lastError: null,
				threadId: null,
				run: null,
				noteId: null,
				reportedAt: null,
			};
			commit([...schedules, schedule]);
			return schedule;
		},
		update(id, patch) {
			const existing = find(id);
			if (!existing) return null;
			const retimed = patch.time !== undefined && patch.time !== existing.time;
			change(id, {
				...patch,
				...(retimed ? { lastSlot: Math.max(existing.lastSlot, now()) } : {}),
			});
			return find(id);
		},
		remove(id) {
			const schedule = find(id);
			if (!schedule) return false;
			if (schedule.run) {
				agent.cancel(schedule.run.threadId);
				comments.remove(schedule.run.threadId);
			}
			commit(schedules.filter((schedule) => schedule.id !== id));
			return true;
		},
		runNow(id) {
			const schedule = find(id);
			if (!schedule) return { error: "No such schedule", status: 404 };
			if (schedule.run) {
				return { error: "This report is already running", status: 409 };
			}
			return start(schedule, null);
		},
		tick() {
			if (stopping) return;
			const at = now();
			for (const { id } of schedules) {
				const schedule = find(id);
				if (!schedule) continue;
				if (schedule.run) {
					settle(schedule);
					continue;
				}
				const slot = lastSlotAtOrBefore(at, schedule.time);
				if (slot > schedule.lastSlot) start(schedule, slot);
			}
		},
		observe(thread) {
			if (stopping || thread.running) return;
			const schedule = schedules.find(
				(candidate) => candidate.run?.threadId === thread.id,
			);
			if (schedule) settle(schedule);
		},
		stop() {
			stopping = true;
		},
		saved: stored.saved,
	};
};
