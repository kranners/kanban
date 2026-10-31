import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountUsage, Usage } from "../shared/types.ts";
import {
	accountChip,
	accountOf,
	accountRemaining,
	accountSeverity,
	linePath,
	nearestSample,
	pickableAccounts,
	severity,
	untilReset,
} from "./usage.ts";

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

const account = (
	number: number,
	extra: Partial<AccountUsage> = {},
): AccountUsage => ({
	id: `${number}`,
	number,
	email: `${number}@example.com`,
	alias: null,
	organization: "",
	configDir: `/backup/sessions/${number}-${number}_example.com`,
	isDefault: false,
	session: null,
	week: null,
	samples: [],
	error: null,
	...extra,
});

test("an account chip prefers the alias, then the slot number", () => {
	const accounts = [account(1, { alias: "home" }), account(2)];
	assert.equal(
		accountChip("/backup/sessions/1-1_example.com", accounts),
		"home",
	);
	assert.equal(accountChip("/backup/sessions/2-2_example.com", accounts), "#2");
	assert.equal(
		accountChip("/backup/sessions/7-gone_example.com", accounts),
		"#7",
	);
	assert.equal(accountOf("/elsewhere", accounts), null);
	assert.equal(
		accountOf("/backup/sessions/2-2_example.com", accounts)?.number,
		2,
	);
});

test("accounts are pickable only with a default and a choice", () => {
	const usage = (accounts: AccountUsage[]): Usage => ({
		session: null,
		week: null,
		samples: [],
		checkedAt: null,
		error: null,
		accounts,
	});
	const chosen = account(2, { isDefault: true });
	assert.equal(pickableAccounts(null), null);
	assert.equal(pickableAccounts(usage([chosen])), null);
	assert.equal(pickableAccounts(usage([account(1), account(3)])), null);
	assert.deepEqual(pickableAccounts(usage([account(1), chosen])), {
		accounts: [account(1), chosen],
		fallback: chosen,
	});
});

test("an account shows the 5h and weekly limit left, rounded", () => {
	const left = account(1, {
		session: { percent: 38.4, resetsAt: null },
		week: { percent: 82.6, resetsAt: null },
	});
	assert.equal(accountRemaining(left), "5h 62% · wk 17%");
	assert.equal(accountSeverity(left), "warning");
	const spent = account(2, {
		session: { percent: 104, resetsAt: null },
		week: null,
	});
	assert.equal(accountRemaining(spent), "5h 0% · wk –");
	assert.equal(accountSeverity(spent), "critical");
	assert.equal(accountRemaining(account(3)), "5h – · wk –");
	assert.equal(accountSeverity(account(3)), "normal");
});
