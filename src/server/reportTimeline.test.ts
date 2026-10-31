import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session, Task } from "../shared/types.ts";
import {
	compactCount,
	entryText,
	formatDuration,
	futureEntries,
	parsePlanLine,
	parseReport,
	pastEntries,
	regionReportBody,
	sessionReportBody,
	tokensText,
} from "./reportTimeline.ts";

const minute = 60_000;
const at = (h: number, m: number) => new Date(2026, 9, 27, h, m).getTime();
const now = new Date(2026, 9, 27, 12, 0);

const session: Session = {
	id: "s1",
	short: null,
	pid: null,
	name: "api",
	cwd: "/x",
	project: "x",
	kind: "background",
	activity: "working",
	doing: null,
	needs: null,
	goal: null,
	startedAt: at(9, 46),
	updatedAt: 0,
	attachable: true,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
};

const task = (over: Partial<Task>): Task => ({
	id: "t",
	subject: "task",
	status: "pending",
	activeForm: null,
	createdAt: at(9, 46),
	startedAt: null,
	endedAt: null,
	...over,
});

const answer = [
	"**Done so far:** wrote the parser.",
	"",
	"## Goal",
	"Ship the new report",
	"layout.",
	"",
	"Left: tests and docs.",
	"",
	"**Plan**",
	"- 10m: write tests",
	"- **1h 30m**: migrate the data",
	"* 5 min - update docs",
	"not a step",
].join("\n");

describe("parsePlanLine", () => {
	it("reads durations in several shapes", () => {
		assert.deepEqual(parsePlanLine("- 10m: write tests"), {
			ms: 10 * minute,
			text: "write tests",
		});
		assert.deepEqual(parsePlanLine("1. 1h 30m — migrate"), {
			ms: 90 * minute,
			text: "migrate",
		});
		assert.deepEqual(parsePlanLine("  -  2 hours :deploy"), {
			ms: 120 * minute,
			text: "deploy",
		});
		assert.equal(parsePlanLine("- write tests"), null);
		assert.equal(parsePlanLine("- 10m:"), null);
	});
});

describe("parseReport", () => {
	it("reads the sections and the plan, tolerating markup and whitespace", () => {
		assert.deepEqual(parseReport(answer), {
			sections: {
				done: "wrote the parser.",
				goal: "Ship the new report layout.",
				left: "tests and docs.",
			},
			plan: [
				{ ms: 10 * minute, text: "write tests" },
				{ ms: 90 * minute, text: "migrate the data" },
				{ ms: 5 * minute, text: "update docs" },
			],
		});
	});

	it("drops sections that say none and ignores prose starting with a heading word", () => {
		assert.deepEqual(
			parseReport("Goal: x\nLeft the server running.\nNeeds you: None."),
			{ sections: { goal: "x Left the server running." }, plan: [] },
		);
	});

	it("gives up on answers without the sections", () => {
		assert.equal(parseReport("- did things\n- more things"), null);
	});
});

describe("formatting", () => {
	it("formats durations", () => {
		assert.equal(formatDuration(134 * minute + 5000), "2h 14m");
		assert.equal(formatDuration(9 * minute), "9m");
		assert.equal(formatDuration(27 * 60 * minute), "1d 3h");
		assert.equal(formatDuration(-5), "0m");
	});

	it("formats counts", () => {
		assert.equal(compactCount(950), "950");
		assert.equal(compactCount(34_500), "34.5k");
		assert.equal(compactCount(1_200_000), "1.2M");
		assert.equal(compactCount(2_000_000), "2M");
	});

	it("totals tokens, or says they are unknown", () => {
		const tokens = {
			input: 1000,
			output: 200_000,
			cacheRead: 1e6,
			cacheWrite: 0,
		};
		assert.equal(tokensText([session]), "Tokens unknown");
		assert.equal(
			tokensText([{ ...session, tokens }]),
			"1.2M tokens, 200k output",
		);
		assert.equal(
			tokensText([{ ...session, tokens }, session]),
			"1.2M tokens, 200k output (some sessions unknown)",
		);
	});
});

describe("pastEntries", () => {
	it("lists the start, finished and started tasks and recent steps in order", () => {
		const s: Session = {
			...session,
			tasks: [
				task({
					id: "a",
					subject: "A",
					status: "completed",
					endedAt: at(10, 0),
				}),
				task({
					id: "b",
					subject: "B",
					activeForm: "Doing B",
					status: "in_progress",
					startedAt: at(11, 0),
				}),
			],
			steps: [{ at: at(10, 30), text: "ran tests" }],
		};
		assert.deepEqual(
			pastEntries(s, now.getTime()).map((e) => e.text),
			["Session started", "Done: A", "ran tests", "Started: Doing B"],
		);
	});

	it("keeps at most eight entries", () => {
		const steps = Array.from({ length: 3 }, (_, i) => ({
			at: at(11, i),
			text: `s${i}`,
		}));
		const tasks = Array.from({ length: 10 }, (_, i) =>
			task({ id: `${i}`, status: "completed", endedAt: at(10, i) }),
		);
		assert.equal(
			pastEntries({ ...session, tasks, steps }, now.getTime()).length,
			8,
		);
	});
});

describe("futureEntries", () => {
	it("accumulates plan durations from now", () => {
		const { entries, finish } = futureEntries(
			session,
			[
				{ ms: 10 * minute, text: "a" },
				{ ms: 20 * minute, text: "b" },
			],
			now.getTime(),
		);
		assert.deepEqual(
			entries.map((e) => [e.at, e.text]),
			[
				[at(12, 10), "a"],
				[at(12, 30), "b"],
			],
		);
		assert.equal(finish, at(12, 30));
	});

	it("falls back to open tasks times the average task duration", () => {
		const s: Session = {
			...session,
			tasks: [
				task({
					id: "a",
					status: "completed",
					startedAt: at(10, 0),
					endedAt: at(10, 20),
				}),
				task({
					id: "b",
					subject: "B",
					status: "in_progress",
					startedAt: at(11, 50),
				}),
				task({ id: "c", subject: "C" }),
			],
		};
		const { entries, finish } = futureEntries(s, [], now.getTime());
		assert.deepEqual(
			entries.map((e) => [e.at, e.text]),
			[
				[at(12, 10), "B"],
				[at(12, 30), "C"],
			],
		);
		assert.equal(finish, at(12, 30));
	});

	it("has no prediction without a plan or task history", () => {
		const s = { ...session, tasks: [task({})] };
		assert.deepEqual(futureEntries(s, [], now.getTime()), {
			entries: [],
			finish: null,
		});
	});
});

describe("sessionReportBody", () => {
	it("lays out sections, stats and a timeline", () => {
		const body = sessionReportBody(session, answer, now);
		assert.equal(
			body,
			[
				"**Done so far:** wrote the parser.",
				"",
				"**Goal:** Ship the new report layout.",
				"",
				"**Left:** tests and docs.",
				"",
				"**Stats**",
				"",
				"- Running 2h 14m",
				"- Tokens unknown",
				"",
				"**Timeline**",
				"",
				"- 09:46 Session started",
				"- **12:00 Now**",
				"- ~12:10 write tests",
				"- ~13:40 migrate the data",
				"- ~13:45 update docs",
				"- **~13:45 Predicted completion**",
			].join("\n"),
		);
	});

	it("falls back to the raw answer", () => {
		const body = sessionReportBody(session, " - free text \n", now);
		assert.ok(body.startsWith("- free text\n\n**Stats**"));
		assert.ok(body.endsWith("- Completion time unknown"));
	});
});

describe("regionReportBody", () => {
	it("gives each session its sections, then combined stats and a merged timeline", () => {
		const web: Session = {
			...session,
			id: "s2",
			name: "web",
			startedAt: at(8, 0),
			tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		};
		const body = regionReportBody(
			[
				{ session, answer: { ok: true, answer } },
				{
					session: web,
					answer: { ok: true, answer: "Goal: polish\nPlan:\n- 2h: polish" },
				},
				{
					session: { ...session, name: "cli" },
					answer: { ok: false, error: "timed out" },
				},
			],
			now,
		);
		assert.match(
			body,
			/^\*\*api\*\*\n\n\*\*Done so far:\*\* wrote the parser\./,
		);
		assert.match(body, /\*\*web\*\*\n\n\*\*Goal:\*\* polish\n\n/);
		assert.match(body, /\*\*cli\*\*\n\n_No answer: timed out_/);
		assert.match(
			body,
			/- Running 4h 0m\n- 10 tokens, 2 output \(some sessions unknown\)/,
		);
		assert.match(
			body,
			/- 08:00 web: Session started\n- 09:46 api: Session started/,
		);
		assert.match(body, /- ~12:10 api: write tests/);
		assert.match(
			body,
			/- ~13:45 api: update docs\n- ~14:00 web: polish\n- \*\*~14:00 Predicted completion\*\*$/,
		);
	});
});

describe("report edge cases", () => {
	it("keeps a plan when no sections were found", () => {
		assert.deepEqual(parseReport("Plan:\n- 10m: write tests"), {
			sections: {},
			plan: [{ ms: 600_000, text: "write tests" }],
		});
	});

	it("flattens, shortens and escapes timeline text", () => {
		assert.equal(entryText("Edit ~/.claude\n  now"), "Edit \\~/.claude now");
		assert.equal(entryText("x".repeat(200)).length, 120);
	});
});
