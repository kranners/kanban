import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	activityOf,
	anchorSpot,
	cornerNear,
	cornerSpot,
	defaultFaceSettings,
	dockAt,
	dockButtonShown,
	dockButtonSize,
	dockButtonSpot,
	faceHoldMs,
	faceMargin,
	faceMotion,
	faceShown,
	isDmKey,
	labelOnLeft,
	newActivity,
	parseDock,
	parseFaceSettings,
	pastThreshold,
	placeFace,
	ringOf,
} from "./butlerDm.ts";

const viewport = { w: 1200, h: 800 };
const size = { w: 200, h: 56 };

const overlaps = (
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inView = (spot: { x: number; y: number }) =>
	spot.x >= faceMargin &&
	spot.y >= faceMargin &&
	spot.x + size.w <= viewport.w - faceMargin &&
	spot.y + size.h <= viewport.h - faceMargin;

test("the ring reads the DM's state, approvals waiting counting as waiting", () => {
	assert.equal(ringOf("idle", 0), "idle");
	assert.equal(ringOf("done", 0), "idle");
	assert.equal(ringOf("working", 0), "working");
	assert.equal(ringOf("working", 2), "waiting");
	assert.equal(ringOf("needs-you", 0), "waiting");
	assert.equal(ringOf("failed", 1), "failed");
});

test("a stored dock is a corner or an anchor inside the viewport, anything else nothing", () => {
	assert.deepEqual(parseDock('{"corner":"top-left"}'), { corner: "top-left" });
	assert.deepEqual(parseDock('{"anchor":{"fx":0.5,"fy":0.1}}'), {
		anchor: { fx: 0.5, fy: 0.1 },
	});
	assert.equal(parseDock('{"corner":"middle"}'), null);
	assert.equal(parseDock('{"anchor":{"fx":2,"fy":0}}'), null);
	assert.equal(parseDock("not json"), null);
	assert.equal(parseDock(null), null);
});

test("a press drags only once it moves 4px", () => {
	assert.equal(pastThreshold({ x: 0, y: 0 }, { x: 3, y: 0 }), false);
	assert.equal(pastThreshold({ x: 0, y: 0 }, { x: 3, y: 3 }), true);
});

test("a release near a corner docks there, elsewhere it holds where dropped", () => {
	assert.equal(cornerNear({ x: 30, y: 30 }, viewport), "top-left");
	assert.equal(cornerNear({ x: 1180, y: 790 }, viewport), "bottom-right");
	assert.equal(cornerNear({ x: 600, y: 20 }, viewport), null);
	assert.deepEqual(dockAt({ x: 1000, y: 0 }, size, viewport), {
		corner: "top-right",
	});
	assert.deepEqual(dockAt({ x: 500, y: 372 }, size, viewport), {
		anchor: { fx: 0.5, fy: 0.5 },
	});
});

test("a corner spot sits inside the margin", () => {
	assert.deepEqual(cornerSpot("top-left", size, viewport), {
		x: faceMargin,
		y: faceMargin,
	});
	assert.deepEqual(cornerSpot("bottom-right", size, viewport), {
		x: 1200 - 200 - faceMargin,
		y: 800 - 56 - faceMargin,
	});
});

test("held at its anchor it never drifts, and stays in view", () => {
	const anchor = { fx: 0.5, fy: 0.5 };
	assert.deepEqual(anchorSpot(anchor, size, viewport), { x: 500, y: 372 });
	assert.ok(inView(anchorSpot({ fx: 1, fy: 0 }, size, viewport)));
});

test("it moves as the old presence did: one quick ease-out snap, a short settle and a quick mood fade, nothing looping", () => {
	assert.ok(faceMotion.moveMs >= 150 && faceMotion.moveMs <= 250);
	assert.ok(faceMotion.settleMs <= 250);
	assert.ok(faceMotion.moodFadeMs <= 100);
	assert.equal(faceMotion.easing, "ease-out");
	const css = readFileSync(
		fileURLToPath(new URL("./butlerDm.css", import.meta.url)),
		"utf8",
	);
	const face = css.slice(
		css.indexOf(".dm-face {"),
		css.indexOf("}", css.indexOf(".dm-face {")),
	);
	assert.match(
		face,
		new RegExp(
			`transition: transform calc\\(${faceMotion.moveMs}ms \\* var\\(--motion\\)\\) ease-out`,
		),
	);
	assert.match(face, new RegExp(`calc\\(${faceMotion.settleMs}ms`));
	assert.match(css, new RegExp(`dm-mood-in calc\\(${faceMotion.moodFadeMs}ms`));
	assert.doesNotMatch(
		css,
		/infinite/,
		"no animation loops: no floating, bobbing or turning ring",
	);
	assert.match(
		css,
		/prefers-reduced-motion: reduce[^}]*\.dm-face,[^}]*animation: none/s,
	);
});

test("face settings default to show only when active with the button, and keep only what they know", () => {
	assert.deepEqual(parseFaceSettings(null), defaultFaceSettings);
	assert.deepEqual(defaultFaceSettings, { mode: "active", hideButton: false });
	assert.deepEqual(parseFaceSettings('{"mode":"never","hideButton":true}'), {
		mode: "never",
		hideButton: true,
	});
	assert.deepEqual(parseFaceSettings('{"mode":"always"}'), {
		mode: "always",
		hideButton: false,
	});
	assert.deepEqual(
		parseFaceSettings('{"mode":"sometimes"}'),
		defaultFaceSettings,
	);
	assert.deepEqual(parseFaceSettings("{"), defaultFaceSettings);
});

const quiet = {
	looking: null,
	working: null,
	dm: { state: "idle" as const, waiting: 0, mood: "content" },
};

test("activity is Butler touching the board, a DM reply arriving or something new waiting on Aaron", () => {
	const t = 1_000_000;
	const base = activityOf(quiet);
	assert.equal(newActivity(base, base, t), null, "nothing new, nothing shown");
	const touched = activityOf({
		...quiet,
		working: { at: t - 10 },
	});
	assert.equal(newActivity(base, touched, t), t - 10);
	const looked = activityOf({ ...quiet, looking: { at: t } });
	assert.equal(newActivity(base, looked, t), t);
	const working = activityOf({
		...quiet,
		dm: { ...quiet.dm, state: "working" },
	});
	assert.equal(
		newActivity(base, working, t),
		null,
		"a DM turn running is not board activity",
	);
	assert.equal(
		newActivity(
			working,
			activityOf({ ...quiet, dm: { ...quiet.dm, mood: "delighted" } }),
			t,
		),
		t,
		"its reply arriving is",
	);
	const asked = activityOf({ ...quiet, dm: { ...quiet.dm, waiting: 1 } });
	assert.equal(newActivity(base, asked, t), t);
	assert.equal(
		newActivity(asked, base, t),
		null,
		"an approval answered is not",
	);
	// A reload shows the face only for board activity still inside the hold.
	assert.equal(newActivity(null, touched, t), t - 10);
	assert.equal(
		newActivity(
			null,
			activityOf({ ...quiet, working: { at: t - faceHoldMs } }),
			t,
		),
		null,
	);
	assert.equal(newActivity(null, asked, t), null);
});

test("the face hides about 4 seconds after his last activity, unless held, and the settings override it", () => {
	assert.equal(faceHoldMs, 4000);
	const t = 50_000;
	const shown = (
		mode: "active" | "always" | "never",
		lastActive: number | null,
		held = false,
	) => faceShown({ mode, lastActive, now: t, held });
	assert.equal(shown("active", null), false, "hidden until he does something");
	assert.equal(shown("active", t - 1000), true);
	assert.equal(shown("active", t - 3999), true);
	assert.equal(
		shown("active", t - 4000),
		false,
		"hidden once the hold runs out",
	);
	assert.equal(
		shown("active", t - 60_000, true),
		true,
		"kept while Aaron points at or drags it",
	);
	assert.equal(shown("always", null), true);
	assert.equal(shown("never", t, true), false);
});

test("while hidden it leaves a small dock button, unless the setting hides it", () => {
	assert.equal(dockButtonShown(defaultFaceSettings, false), true);
	assert.equal(
		dockButtonShown(defaultFaceSettings, true),
		false,
		"no button beside the face",
	);
	assert.equal(
		dockButtonShown({ mode: "never", hideButton: false }, false),
		true,
	);
	assert.equal(
		dockButtonShown({ mode: "active", hideButton: true }, false),
		false,
	);
	assert.ok(dockButtonSize <= 32, "a tiny face");
});

test("the dock button sits in the board's bottom right, clear of the controls there", () => {
	const area = { x: 0, y: 52, w: 1396, h: 848 };
	const spot = dockButtonSpot(area, []);
	assert.deepEqual(spot, {
		x: 1396 - dockButtonSize - faceMargin,
		y: 52 + 848 - dockButtonSize - faceMargin,
	});
	const fab = { x: 1324, y: 828, w: 56, h: 56 };
	const topbar = { x: 0, y: 0, w: 1440, h: 52 };
	const zoom = { x: 16, y: 860, w: 200, h: 34 };
	const clear = dockButtonSpot(area, [fab, topbar, zoom]);
	const box = { ...clear, w: dockButtonSize, h: dockButtonSize };
	for (const control of [fab, topbar, zoom]) assert.ok(!overlaps(box, control));
	assert.ok(clear.x + dockButtonSize <= area.x + area.w);
	assert.ok(clear.y >= area.y);
});

test("B opens the DM, but not while typing or with a modifier", () => {
	const press = {
		key: "b",
		repeat: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
	};
	assert.equal(isDmKey(press, false), true);
	assert.equal(isDmKey({ ...press, key: "B" }, false), true);
	assert.equal(isDmKey(press, true), false);
	assert.equal(isDmKey({ ...press, metaKey: true }, false), false);
	assert.equal(isDmKey({ ...press, repeat: true }, false), false);
});

test("an active face never covers the top bar or a card", () => {
	const topbar = { x: 0, y: 0, w: 1200, h: 52 };
	const card = { x: 700, y: 60, w: 300, h: 200 };
	const spot = placeFace({
		size,
		viewport,
		avoid: [card],
		controls: [topbar],
		target: null,
		wanted: anchorSpot({ fx: 0.78, fy: 0.05 }, size, viewport),
		docked: false,
	});
	assert.ok(!overlaps({ ...spot, ...size }, topbar));
	assert.ok(!overlaps({ ...spot, ...size }, card));
	assert.ok(inView(spot));
});

test("parks beside what Butler touches without covering a card or a control", () => {
	const target = { x: 400, y: 300, w: 300, h: 200 };
	const rail = { x: 1100, y: 0, w: 100, h: 800 };
	const spot = placeFace({
		size,
		viewport,
		avoid: [target],
		controls: [rail],
		target,
		wanted: { x: 900, y: 100 },
		docked: false,
	});
	assert.ok(inView(spot));
	assert.ok(!overlaps({ ...spot, ...size }, target));
	assert.ok(!overlaps({ ...spot, ...size }, rail));
	assert.equal(spot.x, 700 + faceMargin, "to the card's right first");
	// With the right side blocked it goes to the left.
	const neighbour = { x: 710, y: 280, w: 300, h: 240 };
	const left = placeFace({
		size,
		viewport,
		avoid: [target, neighbour],
		controls: [],
		target,
		wanted: { x: 900, y: 100 },
		docked: false,
	});
	assert.equal(left.x, 400 - 200 - faceMargin);
});

test("away from a target it takes the clear spot nearest where it wants to be", () => {
	const card = { x: 850, y: 80, w: 300, h: 200 };
	const spot = placeFace({
		size,
		viewport,
		avoid: [card],
		controls: [],
		target: null,
		wanted: { x: 900, y: 100 },
		docked: false,
	});
	assert.ok(inView(spot));
	assert.ok(!overlaps({ ...spot, ...size }, card));
	assert.ok(Math.hypot(spot.x - 900, spot.y - 100) < 300);
	// Wanting a spot off screen still lands inside it.
	const clamped = placeFace({
		size,
		viewport,
		avoid: [],
		controls: [],
		target: null,
		wanted: { x: 5000, y: -40 },
		docked: false,
	});
	assert.ok(inView(clamped));
});

test("a docked face stays in its corner, even over a card", () => {
	const corner = cornerSpot("bottom-left", size, viewport);
	const spot = placeFace({
		size,
		viewport,
		avoid: [{ x: 0, y: 600, w: 400, h: 200 }],
		controls: [],
		target: { x: 500, y: 300, w: 100, h: 100 },
		wanted: corner,
		docked: true,
	});
	assert.deepEqual(spot, corner);
	// It slides along the edge off a fixed control, never out of view.
	const bar = { x: 0, y: 0, w: 1200, h: 48 };
	const top = placeFace({
		size,
		viewport,
		avoid: [],
		controls: [bar],
		target: null,
		wanted: cornerSpot("top-left", size, viewport),
		docked: true,
	});
	assert.equal(top.x, faceMargin);
	assert.ok(top.y >= 48 + 4 && top.y < 48 + 4 + 8 + 8);
});

test("the status sits on the side away from the nearer edge", () => {
	assert.equal(labelOnLeft({ x: 1000, y: 0 }, size, viewport), true);
	assert.equal(labelOnLeft({ x: 20, y: 0 }, size, viewport), false);
});
