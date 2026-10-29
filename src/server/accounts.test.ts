import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AccountUsage, Usage } from "../shared/types.ts";
import {
	accountId,
	claudeEnv,
	createAccountMonitor,
	cswapRoot,
	loadAccountSamples,
	parseAccounts,
	profileDir,
	switchResult,
	withAccounts,
} from "./accounts.ts";
import { sampleWindowMs } from "./usage.ts";

const root = "/backup";

const listing = (fetchedAt = "2026-10-29T23:09:42Z") => ({
	schemaVersion: 1,
	activeAccountNumber: 2,
	accounts: [
		{
			number: 1,
			email: "one@example.com",
			organizationName: "One Org",
			organizationUuid: "org-1",
			active: false,
			alias: "home",
			usageStatus: "ok",
			usage: {
				fiveHour: { pct: 12.5, resetsAt: "2026-10-30T03:50:00.031636+00:00" },
				sevenDay: { pct: 40, resetsAt: "2026-11-01T19:00:00+00:00" },
			},
			usageFetchedAt: fetchedAt,
		},
		{
			number: 2,
			email: "two@example.com",
			organizationName: "Two Org",
			organizationUuid: "org-2",
			active: true,
			usageStatus: "unavailable",
			usage: null,
			lastGoodUsage: { fiveHour: { pct: 0 }, sevenDay: { pct: 100 } },
			lastGoodFetchedAt: "2026-10-29T22:00:00Z",
		},
		{
			number: 3,
			email: "three@example.com",
			organizationName: "",
			organizationUuid: "",
			active: false,
			usageStatus: "token_expired",
			usage: null,
		},
		{ number: "x", email: "bad@example.com" },
	],
});

describe("parseAccounts", () => {
	it("reads every account with its windows, profile and status", () => {
		assert.deepEqual(parseAccounts(listing(), root), [
			{
				id: "one@example.com|org-1",
				number: 1,
				email: "one@example.com",
				alias: "home",
				organization: "One Org",
				configDir: "/backup/sessions/1-one_example.com",
				isDefault: false,
				session: {
					percent: 12.5,
					resetsAt: Date.parse("2026-10-30T03:50:00.031Z"),
				},
				week: { percent: 40, resetsAt: Date.parse("2026-11-01T19:00:00Z") },
				error: null,
				fetchedAt: Date.parse("2026-10-29T23:09:42Z"),
			},
			{
				id: "two@example.com|org-2",
				number: 2,
				email: "two@example.com",
				alias: null,
				organization: "Two Org",
				configDir: "/backup/sessions/2-two_example.com",
				isDefault: true,
				session: { percent: 0, resetsAt: null },
				week: { percent: 100, resetsAt: null },
				error: "Usage unavailable",
				fetchedAt: Date.parse("2026-10-29T22:00:00Z"),
			},
			{
				id: "three@example.com|",
				number: 3,
				email: "three@example.com",
				alias: null,
				organization: "",
				configDir: "/backup/sessions/3-three_example.com",
				isDefault: false,
				session: null,
				week: null,
				error: "Sign-in expired",
				fetchedAt: null,
			},
		]);
	});

	it("rejects anything but a version 1 listing", () => {
		assert.equal(parseAccounts(null, root), null);
		assert.equal(parseAccounts({ schemaVersion: 2, accounts: [] }, root), null);
		assert.equal(parseAccounts({ schemaVersion: 1 }, root), null);
	});

	it("spells an unknown status out", () => {
		const [row] =
			parseAccounts(
				{
					schemaVersion: 1,
					accounts: [
						{ number: 1, email: "a@example.com", usageStatus: "rate_limited" },
					],
				},
				root,
			) ?? [];
		assert.equal(row?.error, "rate limited");
	});
});

describe("profiles", () => {
	it("names a profile the way cswap slugs its email", () => {
		assert.equal(
			profileDir(root, 2, "one@example.com"),
			"/backup/sessions/2-one_example.com",
		);
		assert.equal(
			profileDir(root, 5, "a+b é@example.com"),
			"/backup/sessions/5-a_b___example.com",
		);
	});

	it("keeps the backup root where cswap does", () => {
		assert.equal(
			cswapRoot("darwin", {}),
			join(homedir(), ".claude-swap-backup"),
		);
		assert.equal(
			cswapRoot("linux", {}),
			join(homedir(), ".local/share/claude-swap"),
		);
		assert.equal(
			cswapRoot("linux", { XDG_DATA_HOME: "/data" }),
			"/data/claude-swap",
		);
		assert.equal(
			cswapRoot("linux", { XDG_DATA_HOME: "relative" }),
			join(homedir(), ".local/share/claude-swap"),
		);
	});

	it("points Claude at a profile only for a non-default home", () => {
		assert.equal(claudeEnv(), process.env);
		assert.equal(claudeEnv("/p").CLAUDE_CONFIG_DIR, "/p");
		assert.equal(claudeEnv("/p").PATH, process.env.PATH);
	});
});

describe("switchResult", () => {
	it("passes a clean switch", () => {
		assert.deepEqual(switchResult(false, '{"ok":true}', ""), { ok: true });
	});

	it("reads cswap's error envelope, else the last line", () => {
		assert.deepEqual(
			switchResult(
				true,
				'{"error":{"type":"not_found","message":"No account 9"}}',
				"",
			),
			{ ok: false, error: "No account 9" },
		);
		assert.deepEqual(switchResult(true, "", "boom\nfinal words\n"), {
			ok: false,
			error: "final words",
		});
		assert.deepEqual(switchResult(true, "", ""), {
			ok: false,
			error: "cswap switch failed",
		});
	});
});

describe("createAccountMonitor", () => {
	const setup = async (body: () => unknown) => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-accounts-"));
		const file = join(dir, "accounts.json");
		const clock = Date.parse("2026-10-30T00:00:00Z");
		let changes = 0;
		const monitor = createAccountMonitor({
			file,
			initial: {
				[accountId("gone@example.com", "org-9")]: [
					{ at: clock - sampleWindowMs - 1, session: 1, week: 1 },
				],
			},
			list: async () => body(),
			root,
			now: () => clock,
			onChange: () => {
				changes += 1;
			},
		});
		return {
			monitor,
			file,
			changes: () => changes,
		};
	};

	it("records one sample per fetch and drops week-old history", async () => {
		let fetchedAt = "2026-10-29T23:09:42Z";
		const { monitor, file, changes } = await setup(() => listing(fetchedAt));
		assert.equal(await monitor.check(), true);
		assert.equal(await monitor.check(), true);
		fetchedAt = "2026-10-29T23:20:00Z";
		await monitor.check();
		const [one, two, three] = monitor.current().accounts;
		assert.deepEqual(
			one?.samples.map((sample) => sample.at),
			[Date.parse("2026-10-29T23:09:42Z"), Date.parse("2026-10-29T23:20:00Z")],
		);
		assert.deepEqual(two?.samples, [
			{ at: Date.parse("2026-10-29T22:00:00Z"), session: 0, week: 100 },
		]);
		assert.deepEqual(three?.samples, []);
		assert.equal(
			monitor.current().checkedAt,
			Date.parse("2026-10-30T00:00:00Z"),
		);
		assert.equal(changes(), 3);
		await monitor.saved();
		assert.deepEqual(Object.keys(await loadAccountSamples(file)).sort(), [
			"one@example.com|org-1",
			"two@example.com|org-2",
		]);
		assert.deepEqual(
			JSON.parse(await readFile(file, "utf8"))["one@example.com|org-1"],
			one?.samples,
		);
	});

	it("falls back when cswap gives no listing", async () => {
		let body: unknown = listing();
		const { monitor, changes } = await setup(() => body);
		await monitor.check();
		body = null;
		assert.equal(await monitor.check(), false);
		assert.deepEqual(monitor.current().accounts, []);
		assert.equal(changes(), 2);
		assert.equal(await monitor.check(), false);
		assert.equal(changes(), 2);
	});
});

describe("withAccounts", () => {
	const single: Usage = {
		session: { percent: 1, resetsAt: null },
		week: { percent: 2, resetsAt: null },
		samples: [{ at: 1, session: 1, week: 2 }],
		checkedAt: 5,
		error: null,
		accounts: [],
	};
	const account = (number: number, isDefault: boolean): AccountUsage => ({
		id: `${number}`,
		number,
		email: `${number}@example.com`,
		alias: null,
		organization: "",
		configDir: `/backup/sessions/${number}-x`,
		isDefault,
		session: { percent: number * 10, resetsAt: null },
		week: { percent: number * 20, resetsAt: null },
		samples: [{ at: number, session: number * 10, week: number * 20 }],
		error: number === 2 ? "Sign-in expired" : null,
	});

	it("shows the default account's windows and history", () => {
		const accounts = [account(1, false), account(2, true)];
		assert.deepEqual(withAccounts(single, { accounts, checkedAt: 9 }), {
			session: { percent: 20, resetsAt: null },
			week: { percent: 40, resetsAt: null },
			samples: [{ at: 2, session: 20, week: 40 }],
			checkedAt: 9,
			error: "Sign-in expired",
			accounts,
		});
	});

	it("keeps the single login without a default account", () => {
		assert.deepEqual(
			withAccounts(single, { accounts: [account(1, false)], checkedAt: 9 }),
			single,
		);
		assert.deepEqual(
			withAccounts(single, { accounts: [], checkedAt: null }),
			single,
		);
	});
});
