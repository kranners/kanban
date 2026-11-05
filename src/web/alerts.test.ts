import assert from "node:assert/strict";
import { test } from "node:test";
import type { Activity, Session } from "../shared/types.ts";
import {
	alertBody,
	alertKind,
	alertTitle,
	badgeLabel,
	favicon,
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
	assert.equal(titleFor(1), "(1) kanban");
	assert.equal(titleFor(10), "(10) kanban");
	assert.equal(titleFor(100), "(100) kanban");
	assert.deepEqual([0, 1, 9, 10, 100].map(badgeLabel), [
		"",
		"1",
		"9",
		"9+",
		"9+",
	]);
	for (const [count, label] of [
		[1, "1"],
		[10, "9+"],
		[100, "9+"],
	] as const) {
		const svg = decodeURIComponent(faviconFor(count));
		assert.match(svg, /^data:image\/svg\+xml,<svg/);
		assert.ok(svg.includes(`>${label}</text>`));
		// Every attribute stands apart, or the browser refuses the image.
		assert.doesNotMatch(svg, /"[a-z-]+=/);
	}
});

function link() {
	const set: string[] = [];
	return {
		set,
		setAttribute: (_: string, href: string) => void set.push(href),
	};
}

test("the favicon shows the badge once it draws and reverts at zero", async () => {
	const icon = link();
	const show = favicon(icon, async () => {});
	await show(3);
	await show(0);
	assert.equal(icon.set.length, 2);
	assert.match(icon.set[0] ?? "", /^data:image\/svg\+xml,/);
	assert.equal(icon.set[1], "favicon.svg");
});

test("the favicon falls back to the plain icon when the badge fails", async () => {
	const icon = link();
	const show = favicon(icon, async () => {
		throw new Error("broken");
	});
	await show(1);
	assert.deepEqual(icon.set, ["favicon.svg"]);
});

test("a slow badge never overwrites a newer count", async () => {
	const icon = link();
	let release = () => {};
	const show = favicon(icon, (src) =>
		src.includes("%3E1%3C")
			? new Promise<void>((done) => {
					release = done;
				})
			: Promise.resolve(),
	);
	const first = show(1);
	await show(0);
	release();
	await first;
	assert.deepEqual(icon.set, ["favicon.svg"]);
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
