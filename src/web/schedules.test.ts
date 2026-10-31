import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Schedule } from "../shared/types.ts";
import {
	freshReports,
	headlineOf,
	promptPreview,
	scheduleStatus,
	when,
} from "./schedules.ts";

process.env.TZ = "Australia/Melbourne";

const at = (day: number, hour: number, minute = 0) =>
	new Date(2026, 10, day, hour, minute).getTime();

const schedule = (fields: Partial<Schedule> = {}): Schedule => ({
	id: "s-1",
	time: "08:00",
	prompt: "What ran overnight?",
	x: 0,
	y: 0,
	mode: "replace",
	createdAt: at(1, 9),
	lastSlot: at(1, 9),
	lastRunAt: null,
	lastError: null,
	threadId: null,
	run: null,
	noteId: null,
	reportedAt: null,
	...fields,
});

describe("fresh reports", () => {
	it("ignores the first frame and reports a newer report once", () => {
		const reported = schedule({ noteId: "n-1", reportedAt: at(2, 8, 3) });
		assert.deepEqual(freshReports(null, [reported]), []);
		assert.deepEqual(freshReports([schedule()], [reported]), [
			{ scheduleId: "s-1", noteId: "n-1", at: at(2, 8, 3) },
		]);
		assert.deepEqual(freshReports([reported], [reported]), []);
	});

	it("announces a report from a schedule made since the last frame", () => {
		const reported = schedule({ noteId: "n-1", reportedAt: at(2, 8, 3) });
		assert.equal(freshReports([], [reported]).length, 1);
	});
});

describe("schedule labels", () => {
	it("says when it last reported", () => {
		assert.equal(when(at(2, 8), at(2, 7)), "today 08:00");
		assert.equal(when(at(3, 8), at(2, 9)), "tomorrow 08:00");
		assert.equal(when(at(1, 8), at(2, 9)), "yesterday 08:00");
		assert.equal(
			scheduleStatus(schedule({ reportedAt: at(2, 8, 2) }), at(2, 9)),
			"Last report today 08:02",
		);
		assert.equal(
			scheduleStatus(
				schedule({ run: { threadId: "t", startedAt: 0, slot: null } }),
				at(2, 9),
			),
			"Writing the report now",
		);
	});

	it("headlines a report from its first lines, keeping code as written", () => {
		assert.equal(
			headlineOf(
				"**Scheduled report · Mon 2 Nov, 08:00**\n\n### Needs you\n- **dark mode tokens**: Allow `npx stylelint --fix 'src/**/*.css'`?\n- more",
			),
			"Needs you · dark mode tokens: Allow npx stylelint --fix 'src/**/*.css'?",
		);
		assert.equal(headlineOf("**Scheduled report**"), "It is on the board");
	});

	it("previews the first line of the prompt", () => {
		assert.equal(promptPreview("  first\nsecond"), "first");
		assert.equal(promptPreview("x".repeat(200)).length, 120);
	});
});
