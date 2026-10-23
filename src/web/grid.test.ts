import assert from "node:assert/strict";
import { test } from "node:test";
import { dotGrid, gridSize, snap, snapPoint, snapWithin } from "./grid.ts";

test("values snap to the nearest grid line", () => {
	assert.equal(snap(0), 0);
	assert.equal(snap(11), 0);
	assert.equal(snap(13), gridSize);
	assert.equal(snap(-13), -gridSize);
	assert.deepEqual(snapPoint({ x: 50, y: 70 }), { x: 48, y: 72 });
});

test("sizes snap within their bounds", () => {
	assert.equal(snapWithin(10, 48, 96), 48);
	assert.equal(snapWithin(500, 48, 96), 96);
	assert.equal(snapWithin(75, 48, 96), 72);
});

test("dots scale with zoom and centre on board grid points", () => {
	const grid = dotGrid({ x: 100, y: -30, k: 2 });
	assert.equal(grid.spacing, gridSize * 2);
	const centre = (offset: number) => offset + grid.spacing / 2;
	assert.equal(Math.abs((100 - centre(grid.x)) % grid.spacing), 0);
	assert.equal(Math.abs((-30 - centre(grid.y)) % grid.spacing), 0);
	assert.ok(grid.x >= 0 && grid.x < grid.spacing);
	assert.ok(grid.y >= 0 && grid.y < grid.spacing);
});

test("dots fade out when zoomed far out", () => {
	assert.equal(dotGrid({ x: 0, y: 0, k: 1 }).fade, 1);
	assert.equal(dotGrid({ x: 0, y: 0, k: 0.15 }).fade, 0);
	const mid = dotGrid({ x: 0, y: 0, k: 0.4 }).fade;
	assert.ok(mid > 0 && mid < 1);
});
