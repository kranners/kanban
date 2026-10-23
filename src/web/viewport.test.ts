import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fitPadding,
	fitView,
	initialView,
	legibleZoom,
	maxZoom,
	minZoom,
	zoomAround,
} from "./viewport.ts";

test("zooming keeps the point under the cursor fixed", () => {
	const view = { x: 10, y: 20, k: 1 };
	const next = zoomAround(view, 2, 110, 120);
	const worldBefore = {
		x: (110 - view.x) / view.k,
		y: (120 - view.y) / view.k,
	};
	const worldAfter = { x: (110 - next.x) / next.k, y: (120 - next.y) / next.k };
	assert.deepEqual(worldAfter, worldBefore);
});

test("zoom is clamped", () => {
	assert.equal(zoomAround({ x: 0, y: 0, k: 1 }, 99, 0, 0).k, maxZoom);
	assert.equal(zoomAround({ x: 0, y: 0, k: 1 }, 0, 0, 0).k, minZoom);
});

test("fit never zooms past 1 and centres the content", () => {
	const small = fitView(
		{ width: 100, height: 100 },
		{ width: 1000, height: 800 },
	);
	assert.equal(small.k, 1);
	assert.equal(small.x, 450);
	const wide = fitView(
		{ width: 4000, height: 500 },
		{ width: 1096, height: 800 },
	);
	assert.equal(wide.k, 0.25);
});

test("a board too large to read starts legible at its top instead", () => {
	const tall = initialView(
		{ width: 1344, height: 1288 },
		{ width: 1160, height: 758 },
	);
	assert.ok(tall.k >= legibleZoom && tall.k <= 1);
	assert.equal(tall.k, (1160 - 2 * fitPadding) / 1344);
	assert.equal(tall.y, fitPadding);
	const wide = initialView(
		{ width: 4000, height: 3000 },
		{ width: 390, height: 700 },
	);
	assert.equal(wide.k, legibleZoom);
	assert.deepEqual([wide.x, wide.y], [fitPadding, fitPadding]);
	const anchored = initialView(
		{ width: 1136, height: 1000 },
		{ width: 390, height: 784 },
		{ x: 418, w: 300 },
	);
	assert.equal(anchored.x + (418 + 150) * anchored.k, 195);
	const nearEdge = initialView(
		{ width: 1136, height: 1000 },
		{ width: 390, height: 784 },
		{ x: 0, w: 300 },
	);
	assert.equal(nearEdge.x, fitPadding);
	const roomy = initialView(
		{ width: 800, height: 600 },
		{ width: 1200, height: 800 },
	);
	assert.equal(roomy.k, 1);
	assert.equal(roomy.x, 200);
});
