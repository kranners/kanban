import assert from "node:assert/strict";
import { test } from "node:test";
import {
	centredOn,
	detailAt,
	farZoom,
	fitPadding,
	fitView,
	fromOrigin,
	initialView,
	legibleZoom,
	maxZoom,
	minZoom,
	nearZoom,
	toBoard,
	toScreen,
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

test("screen and board points convert both ways", () => {
	const view = { x: 40, y: -20, k: 0.5 };
	const board = toBoard(view, { x: 140, y: 80 });
	assert.deepEqual(board, { x: 200, y: 200 });
	assert.deepEqual(toScreen(view, board), { x: 140, y: 80 });
});

test("a view fitted to content at the origin can be moved to content elsewhere", () => {
	const view = fromOrigin({ x: 10, y: 20, k: 2 }, { x: 100, y: -50 });
	assert.deepEqual(toScreen(view, { x: 100, y: -50 }), { x: 10, y: 20 });
});

test("centring on a card puts its middle in the middle of the box", () => {
	const view = centredOn(
		{ x: 100, y: 200, w: 400, h: 300 },
		{ width: 1000, height: 800 },
		1,
	);
	assert.deepEqual(toScreen(view, { x: 300, y: 350 }), { x: 500, y: 400 });
});

test("centring on a card zooms in to a legible size but never out", () => {
	const card = { x: 0, y: 0, w: 400, h: 300 };
	assert.equal(
		centredOn(card, { width: 1000, height: 800 }, 0.2).k,
		legibleZoom,
	);
	assert.equal(centredOn(card, { width: 1000, height: 800 }, 1.5).k, 1.5);
});

test("zoom picks far, medium or near detail", () => {
	assert.equal(detailAt(minZoom), "far");
	assert.equal(detailAt(farZoom), "medium");
	assert.equal(detailAt(1), "medium");
	assert.equal(detailAt(nearZoom), "near");
	assert.equal(detailAt(maxZoom), "near");
});

test("centring from far out lands on the medium cards", () => {
	assert.equal(detailAt(legibleZoom), "medium");
});
