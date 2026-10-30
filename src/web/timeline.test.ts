import assert from "node:assert/strict";
import { test } from "node:test";
import type { Activity, Session, Task, TaskStatus } from "../shared/types.ts";
import {
	averageTaskMs,
	finishedSpans,
	latestFinish,
	marksOf,
	sessionLane,
	windowOf,
} from "./timeline.ts";

const minute = 60_000;
const now = Date.UTC(2026, 9, 30, 12, 0);
const ago = (minutes: number) => now - minutes * minute;

function task(
	id: string,
	status: TaskStatus,
	times: Partial<Pick<Task, "createdAt" | "startedAt" | "endedAt">> = {},
): Task {
	return {
		id,
		subject: `task ${id}`,
		status,
		activeForm: null,
		createdAt: ago(60),
		startedAt: null,
		endedAt: null,
		...times,
	};
}

function session(activity: Activity, tasks: Task[]): Session {
	return {
		id: "s",
		short: "s",
		pid: null,
		name: "s",
		cwd: "/tmp/s",
		project: "s",
		kind: "background",
		activity,
		doing: null,
		needs: null,
		goal: null,
		startedAt: ago(60),
		updatedAt: now,
		attachable: true,
		cmux: false,
		artifacts: [],
		tasks,
		steps: [],
	} as Session;
}

const tenMinuteTasks = [
	task("1", "completed", { startedAt: ago(40), endedAt: ago(30) }),
	task("2", "completed", { endedAt: ago(20) }),
	task("3", "in_progress", { startedAt: ago(4) }),
	task("4", "pending"),
	task("5", "pending"),
];

test("a finished task runs from its start or the previous task's end", () => {
	const spans = finishedSpans(tenMinuteTasks);
	assert.deepEqual(spans.get("1"), {
		start: ago(40),
		end: ago(30),
		kind: "done",
	});
	assert.deepEqual(spans.get("2"), {
		start: ago(30),
		end: ago(20),
		kind: "done",
	});
	assert.equal(
		averageTaskMs([session("working", tenMinuteTasks)]),
		10 * minute,
	);
});

test("open tasks are projected one after another at the typical length", () => {
	const lane = sessionLane(session("working", tenMinuteTasks), "s", now, null);
	assert.deepEqual(
		lane.spans.slice(2).map((span) => [span.kind, span.start, span.end]),
		[
			["active", ago(4), now + 6 * minute],
			["planned", now + 6 * minute, now + 16 * minute],
			["planned", now + 16 * minute, now + 26 * minute],
		],
	);
	assert.equal(lane.finish, now + 26 * minute);
});

test("a task running past the typical length is projected to end now", () => {
	const late = [
		task("1", "completed", { startedAt: ago(40), endedAt: ago(30) }),
		task("2", "in_progress", { startedAt: ago(25) }),
	];
	assert.equal(
		sessionLane(session("working", late), "s", now, null).finish,
		now,
	);
});

test("without finished tasks of its own a session borrows the board's typical length", () => {
	const fresh = [
		task("1", "in_progress", { startedAt: ago(2) }),
		task("2", "pending"),
	];
	assert.equal(
		sessionLane(session("working", fresh), "s", now, 5 * minute).finish,
		now + 8 * minute,
	);
	const unknown = sessionLane(session("working", fresh), "s", now, null);
	assert.equal(unknown.finish, null);
	assert.deepEqual(
		unknown.spans.map((span) => span.kind),
		["active"],
	);
});

test("only sessions still at work are projected", () => {
	for (const activity of ["idle", "done", "stopped", "failed"] as Activity[]) {
		const lane = sessionLane(session(activity, tenMinuteTasks), "s", now, null);
		assert.equal(lane.finish, null, activity);
		assert.ok(!lane.spans.some((span) => span.kind === "planned"), activity);
	}
	assert.equal(
		sessionLane(session("needs-you", tenMinuteTasks), "s", now, null).finish,
		now + 26 * minute,
	);
});

test("a finished list has no finish ahead", () => {
	const done = [task("1", "completed", { startedAt: ago(9), endedAt: ago(3) })];
	assert.equal(
		sessionLane(session("working", done), "s", now, null).finish,
		null,
	);
});

test("the window spans the lanes, at most three hours back, with room ahead", () => {
	const lanes = [
		sessionLane(session("working", tenMinuteTasks), "a", now, null),
		{ key: "b", label: "b", spans: [], finish: null, ticks: [ago(600)] },
	];
	const range = windowOf(lanes, now);
	assert.ok(range.start <= ago(180) && range.start > ago(200));
	assert.equal(range.end, now + 46 * minute);
	assert.equal(latestFinish(lanes), now + 26 * minute);
});

test("marks fall every quarter hour, or every hour on a long window", () => {
	assert.deepEqual(marksOf({ start: ago(20), end: now + 10 * minute }), [
		ago(15),
		now,
	]);
	assert.equal(marksOf({ start: ago(300), end: now }).length, 6);
});
