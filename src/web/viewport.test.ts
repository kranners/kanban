import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fitView,
	initialView,
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

test("a board too large to read starts on its anchor instead", () => {
	const anchor = { x: 1000, y: 0, w: 300, h: 234 };
	const view = initialView(
		{ width: 4000, height: 3000 },
		{ width: 390, height: 700 },
		anchor,
	);
	assert.equal(view.k, 1);
	assert.equal(view.x + (anchor.x + anchor.w / 2) * view.k, 195);
	const roomy = initialView(
		{ width: 800, height: 600 },
		{ width: 1200, height: 800 },
		anchor,
	);
	assert.equal(roomy.k, 1);
	assert.equal(roomy.x, 200);
});
