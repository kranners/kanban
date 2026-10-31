import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { lastSlotAtOrBefore } from "../shared/schedules.ts";
import type { CommentThread, Note, Schedule } from "../shared/types.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { AuditEvent } from "./audit.ts";
import { createCommentStore } from "./comments.ts";
import {
	createScheduler,
	loadSchedules,
	parseScheduleDraft,
	parseSchedulePatch,
	reportNoteText,
	reportPromptFor,
	type Scheduler,
} from "./schedules.ts";

process.env.TZ = "Australia/Melbourne";

const at = (day: number, hour: number, minute = 0) =>
	new Date(2026, 10, day, hour, minute).getTime();

const draft = {
	time: "08:00",
	prompt: "What ran overnight?",
	x: 96,
	y: 48,
	mode: "replace" as const,
};

const setup = async (
	initial: Schedule[] = [],
	threads: CommentThread[] = [],
) => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-schedules-"));
	const file = join(dir, "schedules.json");
	let clock = at(1, 9);
	let ids = 0;
	let busy = false;
	let scheduler: Scheduler | null = null;
	const asked: [string, string][] = [];
	const cancelled: string[] = [];
	const events: AuditEvent[] = [];
	const comments = createCommentStore({
		file: join(dir, "comments.json"),
		initial: threads,
		onChange: (thread) => scheduler?.observe(thread),
		onRemove: () => {},
		newId: () => `thread-${++ids}`,
		now: () => clock,
	});
	const annotations = createAnnotationStore({
		file: join(dir, "annotations.json"),
		initial: {},
		onChange: () => {},
	});
	const created = createScheduler({
		file,
		initial,
		onChange: () => {},
		comments,
		agent: {
			ask: (threadId, text) => {
				if (busy) {
					return { error: "At most 4 board agents run at once", status: 409 };
				}
				asked.push([threadId, text]);
				comments.update(threadId, (thread) => ({
					...thread,
					running: true,
					events: [...thread.events, { kind: "user", at: clock, text }],
				}));
				return { ok: true };
			},
			cancel: (threadId) => {
				cancelled.push(threadId);
				return true;
			},
		},
		annotations,
		occupied: () => [],
		audit: (event) => events.push(event),
		now: () => clock,
		newId: () => `id-${++ids}`,
	});
	scheduler = created;
	const finish = (threadId: string, reply: string | null, error?: string) =>
		comments.update(threadId, (thread) => ({
			...thread,
			running: false,
			events: [
				...thread.events,
				...(reply === null
					? []
					: [{ kind: "reply" as const, at: clock, text: reply }]),
				...(error ? [{ kind: "error" as const, at: clock, text: error }] : []),
			],
		}));
	const notes = () =>
		Object.values(annotations.current()).filter(
			(a): a is Note => a.kind === "note",
		);
	return {
		file,
		dir,
		scheduler: created,
		comments,
		asked,
		cancelled,
		events,
		finish,
		notes,
		setClock: (next: number) => {
			clock = next;
		},
		setBusy: (next: boolean) => {
			busy = next;
		},
	};
};

describe("schedule slots", () => {
	it("finds today's slot once it has passed, else yesterday's", () => {
		assert.equal(lastSlotAtOrBefore(at(2, 8), "08:00"), at(2, 8));
		assert.equal(lastSlotAtOrBefore(at(2, 7, 59), "08:00"), at(1, 8));
	});

	it("keeps local wall-clock time across a daylight saving change", () => {
		const before = new Date(2026, 9, 3, 12).getTime();
		const after = new Date(2026, 9, 4, 12).getTime();
		assert.equal(after - before, 23 * 60 * 60_000);
		assert.equal(
			lastSlotAtOrBefore(after, "08:00"),
			new Date(2026, 9, 4, 8).getTime(),
		);
		assert.equal(new Date(lastSlotAtOrBefore(after, "08:00")).getHours(), 8);
	});
});

describe("parsing schedules", () => {
	it("checks drafts and patches", () => {
		assert.deepEqual(parseScheduleDraft(draft), draft);
		assert.deepEqual(parseScheduleDraft({ ...draft, time: "24:00" }), {
			error: "time must be HH:MM on a 24-hour clock",
		});
		assert.deepEqual(parseScheduleDraft({ ...draft, prompt: " " }), {
			error: "prompt must be between 1 and 4000 characters",
		});
		assert.deepEqual(parseScheduleDraft({ ...draft, mode: "append" }), {
			error: "mode must be replace or stack",
		});
		assert.deepEqual(parseScheduleDraft({ time: "08:00" }), {
			error: "time, prompt, x, y and mode are required",
		});
		assert.deepEqual(parseSchedulePatch({ time: "07:30" }), { time: "07:30" });
		assert.deepEqual(parseSchedulePatch({}), { error: "Nothing to change" });
		assert.deepEqual(parseSchedulePatch({ id: "x" }), {
			error: "Unknown field id",
		});
	});

	it("tells the agent the window and to answer with only the report", () => {
		const prompt = reportPromptFor("What ran?", at(1, 8), at(2, 8));
		assert.match(prompt, /^What ran\?\n/);
		assert.match(prompt, /board_history with since "2026-10-31T21:00:00.000Z"/);
		assert.match(prompt, /Australia\/Melbourne/);
		assert.match(prompt, /do not call put_note/);
	});
});

describe("scheduler", () => {
	it("does not fire a slot that passed before the schedule was made", async () => {
		const { scheduler, asked, setClock } = await setup();
		scheduler.create(draft);
		scheduler.tick();
		assert.equal(asked.length, 0);
		setClock(at(2, 7, 59));
		scheduler.tick();
		assert.equal(asked.length, 0);
		setClock(at(2, 8));
		scheduler.tick();
		assert.equal(asked.length, 1);
	});

	it("runs a missed slot once after days asleep, covering since the last report", async () => {
		const { scheduler, asked, finish, setClock, notes } = await setup();
		const schedule = scheduler.create(draft);
		assert.ok(schedule);
		setClock(at(2, 8));
		scheduler.tick();
		const first = asked[0]?.[0] ?? "";
		finish(first, "## Overnight\n- all quiet");
		assert.equal(notes().length, 1);
		setClock(at(5, 13, 20));
		scheduler.tick();
		scheduler.tick();
		assert.equal(asked.length, 2);
		assert.match(asked[1]?.[1] ?? "", /since "2026-11-01T21:00:00.000Z"/);
		const current = scheduler.current()[0];
		assert.equal(current?.lastSlot, at(5, 8));
		assert.equal(current?.run?.threadId, asked[1]?.[0]);
	});

	it("retries a slot the board agent had no room for", async () => {
		const { scheduler, asked, setClock, setBusy } = await setup();
		scheduler.create(draft);
		setClock(at(2, 8));
		setBusy(true);
		scheduler.tick();
		assert.equal(asked.length, 0);
		assert.equal(
			scheduler.current()[0]?.lastError,
			"At most 4 board agents run at once",
		);
		setBusy(false);
		setClock(at(2, 8, 1));
		scheduler.tick();
		assert.equal(asked.length, 1);
		assert.equal(scheduler.current()[0]?.lastError, null);
	});

	it("replaces its note in place and swaps its thread", async () => {
		const { scheduler, asked, finish, setClock, notes, comments } =
			await setup();
		const schedule = scheduler.create(draft);
		assert.ok(schedule);
		setClock(at(2, 8));
		scheduler.tick();
		finish(asked[0]?.[0] ?? "", "first");
		const [note] = notes();
		assert.ok(note);
		assert.match(
			note.text,
			/^\*\*Scheduled report · Mon 2 Nov, 08:00\*\*\n\nfirst$/,
		);
		assert.equal(scheduler.current()[0]?.noteId, note.id);
		setClock(at(3, 8));
		scheduler.tick();
		finish(asked[1]?.[0] ?? "", "second");
		assert.equal(notes().length, 1);
		assert.equal(notes()[0]?.id, note.id);
		assert.match(notes()[0]?.text ?? "", /second$/);
		assert.deepEqual(
			comments.current().map((thread) => thread.id),
			[asked[1]?.[0]],
		);
	});

	it("stacks a new note each run in stack mode", async () => {
		const { scheduler, asked, finish, setClock, notes } = await setup();
		scheduler.create({ ...draft, mode: "stack" });
		setClock(at(2, 8));
		scheduler.tick();
		finish(asked[0]?.[0] ?? "", "first");
		setClock(at(3, 8));
		scheduler.tick();
		finish(asked[1]?.[0] ?? "", "second");
		assert.equal(notes().length, 2);
	});

	it("notes a failure and keeps the window open for the next report", async () => {
		const { scheduler, asked, finish, setClock, notes, events } = await setup();
		scheduler.create(draft);
		setClock(at(2, 8));
		scheduler.tick();
		finish(
			asked[0]?.[0] ?? "",
			null,
			"The agent took too long and was stopped",
		);
		assert.match(
			notes()[0]?.text ?? "",
			/The report did not finish: The agent took too long and was stopped/,
		);
		const current = scheduler.current()[0];
		assert.equal(current?.lastRunAt, null);
		assert.equal(current?.lastError, "The agent took too long and was stopped");
		assert.equal(events.at(-1)?.action, "scheduled-report");
		setClock(at(3, 8));
		scheduler.tick();
		assert.match(asked[1]?.[1] ?? "", /since "2026-11-01T21:00:00.000Z"/);
	});

	it("runs again after the board restarted mid-report", async () => {
		const first = await setup();
		first.scheduler.create(draft);
		first.setClock(at(2, 8));
		first.scheduler.tick();
		first.scheduler.stop();
		first.finish(
			first.asked[0]?.[0] ?? "",
			"half a report",
			"The board server stopped, so this run was stopped",
		);
		assert.equal(first.notes().length, 0);
		await first.scheduler.saved();
		await first.comments.saved();
		const second = await setup(
			await loadSchedules(first.file),
			first.comments.current(),
		);
		const restored = second.scheduler.current()[0];
		assert.equal(restored?.run, null);
		assert.equal(restored?.lastSlot, at(2, 8) - 1);
		assert.deepEqual(second.comments.current(), []);
		second.setClock(at(2, 8, 2));
		second.scheduler.tick();
		assert.equal(second.asked.length, 1);
	});

	it("runs again after a crash left only interim text in the thread", async () => {
		const first = await setup();
		first.scheduler.create(draft);
		first.setClock(at(2, 8));
		first.scheduler.tick();
		const thread = first.asked[0]?.[0] ?? "";
		first.comments.update(thread, (current) => ({
			...current,
			events: [
				...current.events,
				{ kind: "reply", at: at(2, 8), text: "I'll start with board_history." },
			],
		}));
		await first.scheduler.saved();
		await first.comments.saved();
		const crashed = first.comments
			.current()
			.map((current) => ({ ...current, running: false }));
		const second = await setup(await loadSchedules(first.file), crashed);
		assert.equal(second.notes().length, 0);
		assert.equal(second.scheduler.current()[0]?.lastRunAt, null);
		second.setClock(at(2, 8, 1));
		second.scheduler.tick();
		assert.equal(second.asked.length, 1);
	});

	it("runs a manual report again after a restart cut it off", async () => {
		const first = await setup();
		const schedule = first.scheduler.create(draft);
		assert.ok(schedule);
		first.setClock(at(2, 10));
		first.scheduler.runNow(schedule.id);
		await first.scheduler.saved();
		const second = await setup(await loadSchedules(first.file));
		second.setClock(at(2, 10, 1));
		second.scheduler.tick();
		assert.equal(second.asked.length, 1);
	});

	it("stops a follow-up still running in the last thread before replacing it", async () => {
		const { scheduler, asked, finish, setClock, comments, cancelled } =
			await setup();
		scheduler.create(draft);
		setClock(at(2, 8));
		scheduler.tick();
		const first = asked[0]?.[0] ?? "";
		finish(first, "report");
		comments.update(first, (thread) => ({ ...thread, running: true }));
		setClock(at(3, 8));
		scheduler.tick();
		assert.deepEqual(cancelled, [first]);
		assert.equal(comments.get(first), null);
	});

	it("stops its run and drops its thread when deleted mid-report", async () => {
		const { scheduler, asked, comments, cancelled, notes } = await setup();
		const schedule = scheduler.create(draft);
		assert.ok(schedule);
		scheduler.runNow(schedule.id);
		const thread = asked[0]?.[0] ?? "";
		assert.ok(scheduler.remove(schedule.id));
		assert.deepEqual(cancelled, [thread]);
		assert.equal(comments.get(thread), null);
		assert.equal(notes().length, 0);
	});

	it("never reports further back than the history reaches", async () => {
		const { scheduler, asked, finish, setClock } = await setup();
		scheduler.create(draft);
		setClock(at(2, 8));
		scheduler.tick();
		finish(asked[0]?.[0] ?? "", "report");
		const later = at(2, 8) + 60 * 24 * 60 * 60_000;
		setClock(later);
		scheduler.tick();
		const since = asked[1]?.[1].match(/since "([^"]+)"/)?.[1] ?? "";
		assert.equal(Date.parse(since), later - 30 * 24 * 60 * 60_000);
	});

	it("does not fire a slot that passed when its time was changed", async () => {
		const { scheduler, asked, setClock } = await setup();
		const schedule = scheduler.create(draft);
		assert.ok(schedule);
		setClock(at(2, 7, 30));
		scheduler.update(schedule.id, { time: "07:00" });
		scheduler.tick();
		assert.equal(asked.length, 0);
		setClock(at(3, 7));
		scheduler.tick();
		assert.equal(asked.length, 1);
	});

	it("refuses a second run while one is going", async () => {
		const { scheduler } = await setup();
		const schedule = scheduler.create(draft);
		assert.ok(schedule);
		assert.deepEqual(scheduler.runNow(schedule.id), { ok: true });
		assert.deepEqual(scheduler.runNow(schedule.id), {
			error: "This report is already running",
			status: 409,
		});
		assert.deepEqual(scheduler.runNow("nope"), {
			error: "No such schedule",
			status: 404,
		});
	});

	it("persists schedules without leaving temporary files", async () => {
		const { scheduler, file, dir } = await setup();
		scheduler.create(draft);
		scheduler.create({ ...draft, time: "18:30", mode: "stack" });
		await scheduler.saved();
		assert.deepEqual(await loadSchedules(file), scheduler.current());
		assert.ok(!(await readdir(dir)).some((name) => name.endsWith(".tmp")));
	});
});

describe("report note text", () => {
	it("says when the thread is gone", () => {
		assert.deepEqual(reportNoteText(null, at(2, 8)), {
			text: "**Scheduled report · Mon 2 Nov, 08:00**\n\nThe report did not finish: Its comment thread was deleted",
			error: "Its comment thread was deleted",
		});
	});
});
