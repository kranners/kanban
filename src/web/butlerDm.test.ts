import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cornerNear,
	cornerSpot,
	dockAt,
	driftSpot,
	faceMargin,
	labelOnLeft,
	parseDock,
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

test("a release near a corner docks there, elsewhere it drifts round the drop", () => {
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

test("the drift wanders slowly round its anchor and stays in view, and holds still under reduced motion", () => {
	const anchor = { fx: 0.5, fy: 0.5 };
	const a = driftSpot(anchor, 0, size, viewport);
	const b = driftSpot(anchor, 1000, size, viewport);
	assert.ok(Math.hypot(b.x - a.x, b.y - a.y) < 20, "a second moves it little");
	for (let t = 0; t < 400_000; t += 7_000) {
		assert.ok(inView(driftSpot({ fx: 0.78, fy: 0.22 }, t, size, viewport)));
	}
	assert.deepEqual(
		driftSpot(anchor, 12_345, size, viewport, true),
		driftSpot(anchor, 0, size, viewport, true),
	);
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
