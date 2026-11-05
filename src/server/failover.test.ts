import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	AccountUsage,
	Board,
	NewSessionRequest,
	Session,
} from "../shared/types.ts";
import { createFailover, retryMs } from "./failover.ts";

const account = (
	number: number,
	week: number,
	extra: Partial<AccountUsage> = {},
): AccountUsage => ({
	id: `a${number}`,
	number,
	email: `a${number}@example.com`,
	alias: `ap${number}`,
	organization: "",
	configDir: `/swap/sessions/${number}`,
	isDefault: false,
	session: { percent: 10, resetsAt: 50_000 },
	week: { percent: week, resetsAt: 900_000 },
	samples: [],
	error: null,
	blocked: null,
	...extra,
});

const session = (id: string, extra: Partial<Session> = {}): Session => ({
	id,
	short: id.slice(0, 8),
	pid: null,
	name: `card ${id}`,
	cwd: "/work/repo",
	project: "repo",
	kind: "background",
	activity: "idle",
	doing: "You've hit your weekly limit · resets Nov 6 at 10pm",
	needs: null,
	goal: "Fix the tests",
	startedAt: 0,
	updatedAt: 0,
	attachable: true,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [{ at: 0, text: "Ran the tests" }],
	configDir: "/swap/sessions/2",
	...extra,
});

const boardOf = (sessions: Session[]) => ({ sessions }) as unknown as Board;

const setup = (accounts: AccountUsage[]) => {
	let at = 1_000;
	const stopped: string[] = [];
	const launched: NewSessionRequest[] = [];
	const notes: string[] = [];
	const failover = createFailover({
		accounts: () => accounts,
		now: () => at,
		stop: async (s) => {
			stopped.push(s.id);
			return { ok: true, output: "" };
		},
		launch: async (request) => {
			launched.push(request);
			return { ok: true, short: "abcdef12" };
		},
		notify: (_id, title) => notes.push(title),
		audit: () => {},
		onChange: () => {},
	});
	return {
		failover,
		stopped,
		launched,
		notes,
		tick: (ms: number) => {
			at += ms;
		},
	};
};

describe("failover placing new sessions", () => {
	const accounts = [
		account(1, 50, { isDefault: true }),
		account(2, 99),
		account(3, 20),
	];

	it("starts a session on the account with most headroom", () => {
		const { failover } = setup(accounts);
		assert.equal(failover.place({ cwd: "/w", prompt: "p" }).account, 3);
	});

	it("keeps an asked-for account that can take it, and swaps one at its limit", () => {
		const { failover } = setup(accounts);
		assert.equal(
			failover.place({ cwd: "/w", prompt: "p", account: 1 }).account,
			1,
		);
		assert.equal(
			failover.place({ cwd: "/w", prompt: "p", account: 2 }).account,
			3,
		);
	});

	it("leaves the default login alone when it is the best", () => {
		const { failover } = setup([
			account(1, 5, { isDefault: true }),
			account(2, 50),
		]);
		assert.equal(failover.place({ cwd: "/w", prompt: "p" }).account, undefined);
		assert.equal(
			failover.place({ cwd: "/w", prompt: "p", account: 2 }).account,
			2,
		);
	});
});

describe("failover moving limited sessions", () => {
	it("resumes a background session on another account, once", async () => {
		const accounts = [
			account(1, 50, { isDefault: true }),
			account(2, 100),
			account(3, 20),
		];
		const { failover, stopped, launched, notes, tick } = setup(accounts);
		const stuck = session("s-1");
		await failover.observe(
			boardOf([stuck, session("s-2", { doing: "Reading files" })]),
		);
		assert.deepEqual(stopped, ["s-1"]);
		assert.equal(launched.length, 1);
		assert.equal(launched[0]?.resume, "s-1");
		assert.equal(launched[0]?.account, 3);
		assert.equal(launched[0]?.runsOn, "local");
		assert.match(launched[0]?.prompt ?? "", /from Claude account ap2 to ap3/);
		assert.deepEqual(notes, ["card s-1: moved from ap2 to ap3 (limit)"]);
		assert.equal(failover.view().moves[0]?.to, "ap3");
		assert.equal(failover.view().cooldowns[2], 900_000);
		await failover.observe(boardOf([stuck]));
		assert.equal(launched.length, 1, "no second move inside the retry window");
		tick(retryMs + 1);
		await failover.observe(boardOf([stuck]));
		assert.equal(launched.length, 2);
	});

	it("hands a cloud session over to a fresh one on another account", async () => {
		const { failover, stopped, launched } = setup([
			account(1, 99, { isDefault: true }),
			account(2, 20),
		]);
		await failover.observe(
			boardOf([
				session("c-1", {
					kind: "background",
					configDir: undefined,
					cloud: { url: "https://claude.ai/code/c-1" },
				}),
			]),
		);
		assert.deepEqual(stopped, []);
		assert.equal(launched[0]?.runsOn, "cloud");
		assert.equal(launched[0]?.account, 2);
		assert.match(launched[0]?.prompt ?? "", /https:\/\/claude\.ai\/code\/c-1/);
	});

	it("leaves terminal and runner sessions alone", async () => {
		const { failover, launched } = setup([
			account(1, 0, { isDefault: true }),
			account(2, 0),
		]);
		await failover.observe(
			boardOf([
				session("t-1", { kind: "interactive" }),
				session("r-1", { runner: { id: "r", name: "pilot" } }),
			]),
		);
		assert.equal(launched.length, 0);
	});

	it("says once when every account is at its limit, and keeps the session", async () => {
		const accounts = [
			account(1, 100, { isDefault: true }),
			account(2, 100),
			account(3, 0, { disabled: true }),
		];
		const { failover, launched, stopped, notes } = setup(accounts);
		await failover.observe(boardOf([session("s-1")]));
		await failover.observe(boardOf([session("s-1")]));
		assert.equal(launched.length, 0);
		assert.equal(stopped.length, 0);
		assert.deepEqual(notes, ["Every Claude account is at its limit"]);
		assert.equal(failover.view().allLimited?.until, 900_000);
	});
});
