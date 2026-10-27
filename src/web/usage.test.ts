import assert from "node:assert/strict";
import { test } from "node:test";
import { linePath, nearestSample, severity, untilReset } from "./usage.ts";

const frame = { from: 0, to: 100 * 60_000, width: 100, height: 50 };
const sample = (minute: number, session: number, week: number) => ({
	at: minute * 60_000,
	session,
	week,
});

test("severity warns from 75% and turns critical at 90%", () => {
	assert.equal(severity(74.9), "normal");
	assert.equal(severity(75), "warning");
	assert.equal(severity(90), "critical");
});

test("a line breaks where the server stopped sampling", () => {
	const samples = [
		sample(0, 0, 10),
		sample(5, 0, 20),
		sample(60, 0, 100),
		sample(65, 0, 50),
	];
	assert.equal(
		linePath(samples, "week", frame),
		"M0 45 h0 L5 40 M60 0 h0 L65 25",
	);
});

test("a lone reading still draws as a dot", () => {
	assert.equal(linePath([sample(50, 0, 50)], "week", frame), "M50 25 h0");
});

test("a line skips samples outside its frame and clamps percents", () => {
	const samples = [sample(-5, 50, 50), sample(10, 140, 0), sample(15, -3, 0)];
	assert.equal(linePath(samples, "session", frame), "M10 0 h0 L15 50");
});

test("nearest sample is the closest in time", () => {
	const samples = [sample(0, 1, 1), sample(10, 2, 2), sample(20, 3, 3)];
	assert.equal(nearestSample(samples, 14 * 60_000, frame)?.session, 2);
	assert.equal(nearestSample([], 0, frame), null);
});

test("nearest sample stays inside the chart's frame", () => {
	const samples = [sample(-50, 9, 9), sample(10, 2, 2)];
	assert.equal(nearestSample(samples, -40 * 60_000, frame)?.session, 2);
	assert.equal(nearestSample([sample(-50, 9, 9)], 0, frame), null);
});

test("time until reset reads in its two largest units", () => {
	const now = 1_000_000_000;
	assert.equal(untilReset(now + 30 * 60_000, now), "30m");
	assert.equal(untilReset(now + 151 * 60_000, now), "2h 31m");
	assert.equal(untilReset(now + (2 * 1440 + 125) * 60_000, now), "2d 2h");
	assert.equal(untilReset(now - 5000, now), "0m");
});
