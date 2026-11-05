import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	bestAccount,
	cooldownUntil,
	fallbackCooldownMs,
	isLimitText,
	nextFree,
	unavailable,
} from "./failover.ts";
import type { AccountUsage } from "./types.ts";

const account = (
	number: number,
	session: number,
	week: number,
	extra: Partial<AccountUsage> = {},
): AccountUsage => ({
	id: `a${number}`,
	number,
	email: `a${number}@example.com`,
	alias: null,
	organization: "",
	configDir: `/p/${number}`,
	isDefault: false,
	session: { percent: session, resetsAt: 5_000 },
	week: { percent: week, resetsAt: 90_000 },
	samples: [],
	error: null,
	blocked: null,
	...extra,
});

describe("isLimitText", () => {
	it("knows Claude Code's limit messages", () => {
		for (const text of [
			"You've hit your weekly limit · resets Nov 6 at 10pm",
			"You've hit your usage limit",
			"you have reached your session limit",
			"Claude AI usage limit reached|1730000000",
			"5-hour limit reached ∙ resets 3pm",
			"API Error: You've hit your weekly limit",
		]) {
			assert.equal(isLimitText(text), true, text);
		}
	});

	it("ignores a session that only talks about limits", () => {
		assert.equal(
			isLimitText("Fixing how we detect You've hit your limit"),
			false,
		);
		assert.equal(isLimitText("Raised the rate limit"), false);
		assert.equal(isLimitText(null), false);
	});
});

describe("bestAccount", () => {
	it("picks the most 5-hour and weekly headroom, skipping spent, held out and cooling accounts", () => {
		const accounts = [
			account(1, 10, 99),
			account(2, 30, 40),
			account(3, 5, 10, { disabled: true }),
			account(4, 20, 20),
			account(5, 0, 0, { blocked: "Free plan" }),
			account(6, 0, 1),
		];
		assert.equal(bestAccount(accounts, { 6: 2_000 }, 1_000)?.number, 4);
		assert.equal(bestAccount(accounts, {}, 1_000)?.number, 6);
		assert.equal(bestAccount(accounts, {}, 1_000, new Set([6, 4, 2])), null);
	});

	it("prefers the default on a tie", () => {
		const accounts = [
			account(1, 10, 10),
			account(2, 10, 10, { isDefault: true }),
		];
		assert.equal(bestAccount(accounts, {}, 0)?.number, 2);
	});

	it("says why an account can't take a session", () => {
		assert.equal(unavailable(account(1, 99, 0), {}, 0), "at its limit");
		assert.equal(
			unavailable(account(1, 0, 0, { session: null }), {}, 0),
			"usage unknown",
		);
		assert.equal(unavailable(account(1, 0, 0), {}, 0), null);
	});
});

describe("cooldownUntil", () => {
	it("waits for the reset of the window that filled", () => {
		assert.equal(cooldownUntil(account(1, 10, 100), 1_000), 90_000);
		assert.equal(cooldownUntil(account(1, 100, 50), 1_000), 5_000);
		assert.equal(cooldownUntil(null, 1_000), 1_000 + fallbackCooldownMs);
	});

	it("finds when the first spent account frees up", () => {
		assert.equal(
			nextFree([account(1, 100, 10), account(2, 10, 100)], {}, 1_000),
			5_000,
		);
	});
});
