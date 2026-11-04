import assert from "node:assert/strict";
import { test } from "node:test";
import type { Activity, Session } from "../shared/types.ts";
import {
	alertBody,
	alertKind,
	alertTitle,
	faviconFor,
	finished,
	seenActivities,
	summoned,
	titleFor,
} from "./alerts.ts";

function session(
	id: string,
	activity: Activity,
	extra: Partial<Session> = {},
): Session {
	return {
		id,
		short: null,
		pid: null,
		name: id,
		cwd: `/work/${id}`,
		project: id,
		kind: "background",
		activity,
		doing: null,
		needs: null,
		goal: null,
		startedAt: 1,
		updatedAt: 1,
		attachable: true,
		cmux: false,
		artifacts: [],
		tasks: [],
		steps: [],
		...extra,
	};
}

test("nothing is summoned on first sight of the board", () => {
	assert.deepEqual(summoned(null, [session("a", "needs-you")]), []);
});

test("a session moving into needs-you is summoned once", () => {
	const before = seenActivities([session("a", "working")]);
	const now = [session("a", "needs-you")];
	assert.deepEqual(
		summoned(before, now).map((s) => s.id),
		["a"],
	);
	assert.deepEqual(summoned(seenActivities(now), now), []);
});

test("a new session that already needs you is summoned", () => {
	const before = seenActivities([]);
	assert.deepEqual(
		summoned(before, [session("b", "needs-you")]).map((s) => s.id),
		["b"],
	);
});

test("other state changes summon nobody", () => {
	const before = seenActivities([session("a", "working")]);
	assert.deepEqual(summoned(before, [session("a", "done")]), []);
});

test("the title counts the sessions that need you", () => {
	assert.equal(titleFor(0), "kanban");
	assert.equal(titleFor(3), "(3) kanban");
});

test("the favicon carries a badge only while someone needs you", () => {
	assert.equal(faviconFor(0), "favicon.svg");
	const one = decodeURIComponent(faviconFor(1));
	assert.match(one, /^data:image\/svg\+xml,<svg/);
	assert.match(one, />1<\/text>/);
	assert.match(decodeURIComponent(faviconFor(12)), />9\+<\/text>/);
});

test("the alert body prefers the question, then what it is doing", () => {
	assert.equal(
		alertBody(session("a", "needs-you", { needs: "Approve Bash?" })),
		"Approve Bash?",
	);
	assert.equal(
		alertBody(session("a", "needs-you", { doing: "Editing" })),
		"Editing",
	);
	assert.equal(alertBody(session("a", "needs-you")), "a");
});

test("a session that stops working has finished", () => {
	const before = seenActivities([
		session("a", "working"),
		session("b", "watching"),
		session("c", "working"),
		session("d", "needs-you"),
	]);
	const now = [
		session("a", "idle"),
		session("b", "done"),
		session("c", "failed"),
		session("d", "idle"),
	];
	assert.deepEqual(
		finished(before, now).map((s) => s.id),
		["a", "b", "c"],
	);
	assert.deepEqual(finished(seenActivities(now), now), []);
	assert.deepEqual(finished(null, now), []);
});

test("a session first seen idle has not finished", () => {
	assert.deepEqual(finished(seenActivities([]), [session("a", "idle")]), []);
});

test("each alerting state has its own kind and title", () => {
	assert.equal(alertKind(session("a", "needs-you")), "needs");
	assert.equal(alertKind(session("a", "idle")), "finished");
	assert.equal(alertKind(session("a", "done")), "finished");
	assert.equal(alertKind(session("a", "failed")), "failed");
	assert.equal(alertKind(session("a", "working")), null);
	assert.equal(alertKind(session("a", "stopped")), null);
	assert.equal(alertTitle(session("a", "needs-you")), "a needs you");
	assert.equal(alertTitle(session("a", "idle")), "a finished");
	assert.equal(alertTitle(session("a", "failed")), "a failed");
});
