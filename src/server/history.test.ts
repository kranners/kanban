import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.TZ = "Australia/Melbourne";

import type { Board, Session } from "../shared/types.ts";
import { historyBudget, readHistory, readTimeline } from "./history.ts";

const since = Date.parse("2026-10-31T21:00:00.000Z");
const after = (minutes: number) => new Date(since + minutes * 60_000);

const job = async (
	home: string,
	short: string,
	state: Record<string, unknown>,
	lines: string[],
) => {
	const dir = join(home, "jobs", short);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "state.json"), JSON.stringify(state));
	await writeFile(join(dir, "timeline.jsonl"), lines.join("\n"));
};

const session = (fields: Partial<Session>): Session => ({
	id: "live-1",
	short: null,
	pid: 1,
	name: "live one",
	cwd: "/Users/me/acme-api",
	project: "acme-api",
	kind: "interactive",
	activity: "working",
	doing: "Running tests",
	needs: null,
	goal: "fix the tests",
	startedAt: since - 60_000,
	updatedAt: since + 60_000,
	attachable: false,
	cmux: true,
	artifacts: [],
	tasks: [],
	steps: [
		{ at: since - 1, text: "old step" },
		{ at: since + 1, text: "Ran tests" },
	],
	...fields,
});

const boardOf = (sessions: Session[]): Board => ({
	sessions,
	subagents: [],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
	links: [],
	messages: [],
	generatedAt: since,
});

describe("readTimeline", () => {
	it("keeps changes since the window, skipping bad lines", async () => {
		const home = await mkdtemp(join(tmpdir(), "kanban-history-"));
		await job(home, "abcd1234", {}, [
			JSON.stringify({ at: after(-5), state: "working", detail: "before" }),
			"not json",
			JSON.stringify({ at: after(1), state: "working", detail: "building" }),
			JSON.stringify({ at: after(2), state: "working", detail: "building" }),
			JSON.stringify({
				at: after(3),
				state: "done",
				detail: "landed",
				text: "Landed on main.",
			}),
		]);
		assert.deepEqual(await readTimeline(home, "abcd1234", since), {
			timeline: [
				{ at: since + 60_000, state: "working", detail: "building" },
				{ at: since + 180_000, state: "done", detail: "landed" },
			],
			lastMessage: "Landed on main.",
		});
		assert.deepEqual(await readTimeline(home, "missing0", since), {
			timeline: [],
			lastMessage: null,
		});
	});
});

describe("readHistory", () => {
	it("lists live and ended sessions blockers first, with what landed", async () => {
		const home = await mkdtemp(join(tmpdir(), "kanban-history-"));
		await job(
			home,
			"0000aaaa",
			{
				sessionId: "ended-ok",
				cwd: "/Users/me/acme-web/.claude/worktrees/login",
				name: "login page",
				state: "done",
				createdAt: after(-30),
				updatedAt: after(40),
			},
			[JSON.stringify({ at: after(40), state: "done", detail: "landed" })],
		);
		await job(
			home,
			"0000bbbb",
			{
				sessionId: "ended-bad",
				cwd: "/Users/me/acme-api",
				name: "migrate db",
				state: "failed",
				createdAt: after(-30),
				updatedAt: after(20),
			},
			[],
		);
		await job(
			home,
			"0000cccc",
			{
				sessionId: "stale",
				cwd: "/Users/me/acme-api",
				state: "done",
				createdAt: after(-300),
				updatedAt: after(-200),
			},
			[],
		);
		const waiting = session({
			id: "blocked",
			name: "deploy",
			activity: "needs-you",
			needs: "Approve the deploy",
			updatedAt: since - 600_000,
		});
		const repos: string[] = [];
		const text = await readHistory(
			{
				homes: () => [home],
				board: () => boardOf([session({}), waiting]),
				gitLog: async (repo) => {
					repos.push(repo);
					return repo.startsWith("/Users/me/acme-web")
						? {
								repo: "/Users/me/acme-web",
								ref: "origin/main",
								commits: [{ sha: "abc1234", at: "", subject: "feat: login" }],
							}
						: null;
				},
			},
			since,
		);
		const blocks = text.split("\n\n");
		assert.equal(
			blocks[0],
			"4 sessions active since 2026-10-31T21:00:00.000Z, blockers first. Times are local.",
		);
		assert.deepEqual(
			blocks.slice(2, 6).map((block) => block.split("\n")[0]),
			[
				"## deploy: needs-you, on the board",
				"## migrate db (0000bbbb): failed, ended, off the board",
				"## live one: working, on the board",
				"## login page (0000aaaa): done, ended, off the board",
			],
		);
		assert.match(blocks[2] ?? "", /\nNeeds: Approve the deploy/);
		assert.match(
			blocks[4] ?? "",
			/\nTimeline: Sun 1 Nov, 08:00 step: Ran tests$/,
		);
		assert.doesNotMatch(blocks[4] ?? "", /old step/);
		assert.deepEqual(repos.toSorted(), [
			"/Users/me/acme-api",
			"/Users/me/acme-web",
		]);
		assert.equal(
			blocks[1],
			"## Landed\n/Users/me/acme-web (origin/main):\n- abc1234  feat: login",
		);
	});
});

describe("history budget", () => {
	it("shares the budget between sessions so the agent can read it", async () => {
		const busy = Array.from({ length: 40 }, (_, index) =>
			session({
				id: `s-${index}`,
				name: `session ${index}`,
				goal: "g".repeat(2000),
				steps: Array.from({ length: 40 }, (_, step) => ({
					at: since + step,
					text: "x".repeat(200),
				})),
			}),
		);
		const text = await readHistory(
			{ homes: () => [], board: () => boardOf(busy), gitLog: async () => null },
			since,
		);
		assert.ok(text.length <= historyBudget);
		assert.equal(text.match(/^## session /gm)?.length, 40);
		assert.match(text, /\n## Landed\nNo commits reached/);
		assert.match(text, /## session 39: working[\s\S]*Timeline: /);
	});
});
