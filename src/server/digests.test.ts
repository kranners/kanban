import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Digests, Session, TranscriptEntry } from "../shared/types.ts";
import type { Summary } from "../web/summaries.ts";
import {
	createDigester,
	type DigestRun,
	digestArgs,
	digestInput,
	failurePauseMs,
	fingerprintOf,
	loadDigests,
	minIntervalMs,
	parseDigest,
} from "./digests.ts";

const at = (hour: number, minute: number) =>
	new Date(2026, 9, 30, hour, minute).getTime();

const session = (id: string, patch: Partial<Session> = {}): Session => ({
	id,
	short: null,
	pid: null,
	name: id,
	cwd: "/dev/acme-api",
	project: "acme-api",
	kind: "background",
	activity: "working",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: at(14, 0),
	attachable: true,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
	...patch,
});

const unitOf = (key: string, ...sessions: Session[]): Summary => ({
	key,
	project: "acme-api",
	cwd: "/dev/acme-api",
	frame: { x: 0, y: 0, w: 0, h: 0 },
	framed: true,
	sessions,
});

const reply = (narrative: string, sessions: Record<string, unknown>[] = []) =>
	JSON.stringify({
		is_error: false,
		result: "",
		structured_output: { narrative, sessions },
	});

describe("digestArgs", () => {
	it("asks haiku with no tools, settings, hooks or saved session", () => {
		const args = digestArgs("the input");
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		assert.equal(args[0], "-p");
		assert.equal(after("--model"), "haiku");
		assert.ok(args.includes("--no-session-persistence"));
		assert.equal(after("--tools"), "");
		assert.equal(after("--setting-sources"), "");
		assert.deepEqual(JSON.parse(after("--settings") ?? ""), {
			disableAllHooks: true,
		});
		assert.deepEqual(args.slice(-2), ["--", "the input"]);
	});
});

describe("digestInput", () => {
	it("labels each session and lists its state, tasks, steps and conversation", () => {
		const working = session("w", {
			name: "auth sweep",
			goal: "Expire stale sessions",
			doing: "Running npm test",
			tasks: [
				{
					id: "1",
					subject: "Add sweep",
					status: "completed",
					activeForm: null,
					createdAt: 0,
					startedAt: null,
					endedAt: null,
				},
				{
					id: "2",
					subject: "Test sweep",
					status: "in_progress",
					activeForm: "Testing",
					createdAt: 0,
					startedAt: null,
					endedAt: null,
				},
				{
					id: "3",
					subject: "Open PR",
					status: "pending",
					activeForm: null,
					createdAt: 0,
					startedAt: null,
					endedAt: null,
				},
			],
			steps: [{ at: at(13, 58), text: "Bash: npm test" }],
		});
		const waiting = session("n", {
			name: "migration",
			activity: "needs-you",
			needs: "Approve the staging migration?",
			updatedAt: at(13, 50),
		});
		const entries = new Map<string, TranscriptEntry[]>([
			[
				"w",
				[
					{ at: at(13, 55), role: "user", text: "Add an  expiry\nsweep" },
					{ at: at(13, 56), role: "tool", text: "ignored tool output" },
					{ at: at(13, 57), role: "assistant", text: "x".repeat(400) },
				],
			],
		]);
		assert.equal(
			digestInput(unitOf("k", working, waiting), entries, at(14, 2)),
			[
				"Project: acme-api (/dev/acme-api)",
				"Time: 14:02",
				"",
				"s1: auth sweep",
				"State: working · updated 14:00",
				"Goal: Expire stale sessions",
				"Doing: Running npm test",
				"Tasks: 1/3 done",
				"- [x] Add sweep",
				"- [>] Test sweep",
				"- [ ] Open PR",
				"Recent steps:",
				"- 13:58 Bash: npm test",
				"Conversation:",
				"- 13:55 user: Add an expiry sweep",
				`- 13:57 assistant: ${"x".repeat(299)}…`,
				"",
				"s2: migration",
				"State: needs-you · updated 13:50",
				"Needs you: Approve the staging migration?",
			].join("\n"),
		);
	});
});

describe("parseDigest", () => {
	const ids = ["first", "second"];

	it("maps session labels in any case to ids and trims the answers", () => {
		const result = parseDigest(
			reply(" Going well. ", [
				{ id: "s1", now: " Testing ", progress: "Half done", stuck: "" },
				{ id: " S2 ", now: "Waiting", progress: "", stuck: " Loops " },
				{ id: "s9", now: "Unknown", progress: "", stuck: "" },
			]),
			"",
			ids,
			5,
		);
		assert.deepEqual(result, {
			ok: true,
			narrative: { at: 5, narrative: "Going well." },
			sessions: {
				first: { at: 5, now: "Testing", progress: "Half done", stuck: null },
				second: { at: 5, now: "Waiting", progress: "", stuck: "Loops" },
			},
		});
	});

	it("fails on an error result", () => {
		const result = parseDigest(
			JSON.stringify({ is_error: true, result: "Credit balance too low" }),
			"",
			ids,
			5,
		);
		assert.deepEqual(result, {
			ok: false,
			error: "The digest came back empty: Credit balance too low",
		});
	});

	it("fails on output that is not JSON", () => {
		assert.deepEqual(parseDigest("", "spawn claude ENOENT\n", ids, 5), {
			ok: false,
			error: "Could not digest: spawn claude ENOENT",
		});
	});

	it("fails on an empty narrative", () => {
		const result = parseDigest(reply("  "), "", ids, 5);
		assert.equal(result.ok, false);
	});
});

describe("fingerprintOf", () => {
	const step = { at: at(13, 0), text: "Read: a.ts" };

	it("ignores times", () => {
		assert.equal(
			fingerprintOf(unitOf("k", session("a", { steps: [step] }))),
			fingerprintOf(
				unitOf(
					"k",
					session("a", {
						updatedAt: at(15, 0),
						steps: [{ ...step, at: at(15, 0) }],
					}),
				),
			),
		);
	});

	it("changes with a new step", () => {
		assert.notEqual(
			fingerprintOf(unitOf("k", session("a", { steps: [step] }))),
			fingerprintOf(
				unitOf(
					"k",
					session("a", { steps: [step, { at: 0, text: "Edit: a.ts" }] }),
				),
			),
		);
	});
});

const harness = async (
	initial: Parameters<typeof createDigester>[0]["initial"] = {},
	file?: string,
) => {
	const state = {
		now: at(14, 0),
		watching: true,
		units: [] as Summary[],
		fail: false,
		runs: [] as string[],
		transcripts: [] as string[],
		changes: [] as Digests[],
		hold: null as Promise<void> | null,
	};
	const run: DigestRun = async (args) => {
		const input = args.at(-1) ?? "";
		state.runs.push(input);
		if (state.hold) await state.hold;
		if (state.fail) return { ok: false, stdout: "", stderr: "boom" };
		const labels = input.match(/^s\d+(?=: )/gm) ?? [];
		return {
			ok: true,
			stdout: reply(
				`Narrative ${state.runs.length}`,
				labels.map((id) => ({
					id,
					now: `Now ${state.runs.length}`,
					progress: "Some",
					stuck: "",
				})),
			),
			stderr: "",
		};
	};
	const digester = createDigester({
		file: file ?? join(await mkdtemp(join(tmpdir(), "digests-")), "d.json"),
		initial,
		units: () => state.units,
		transcript: async (id) => {
			state.transcripts.push(id);
			return [];
		},
		run,
		watching: () => state.watching,
		now: () => state.now,
		onChange: (next) => state.changes.push(next),
	});
	return { state, digester };
};

const quietly = async (body: () => Promise<void>) => {
	const original = console.error;
	console.error = () => {};
	try {
		await body();
	} finally {
		console.error = original;
	}
};

describe("createDigester", () => {
	it("digests each changed frame once and skips unchanged ones", async () => {
		const { state, digester } = await harness();
		state.units = [unitOf("a", session("a1")), unitOf("b", session("b1"))];
		await digester.pump();
		assert.equal(state.runs.length, 2);
		state.now += minIntervalMs;
		await digester.pump();
		assert.equal(state.runs.length, 2);
		assert.deepEqual(Object.keys(digester.current().projects).sort(), [
			"a",
			"b",
		]);
		assert.equal(digester.current().sessions.a1?.stuck, null);
	});

	it("waits minIntervalMs before digesting a frame again", async () => {
		const { state, digester } = await harness();
		state.units = [unitOf("a", session("a1"))];
		await digester.pump();
		state.units = [unitOf("a", session("a1", { doing: "Something new" }))];
		state.now += minIntervalMs - 1;
		await digester.pump();
		assert.equal(state.runs.length, 1);
		state.now += 1;
		await digester.pump();
		assert.equal(state.runs.length, 2);
	});

	it("never runs two digests at once", async () => {
		const { state, digester } = await harness();
		let release = () => {};
		state.hold = new Promise((resolve) => {
			release = resolve;
		});
		state.units = [unitOf("a", session("a1")), unitOf("b", session("b1"))];
		const first = digester.pump();
		await digester.pump();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.runs.length, 1);
		release();
		await first;
		assert.equal(state.runs.length, 2);
	});

	it("digests the frame needing attention first", async () => {
		const { state, digester } = await harness();
		state.hold = new Promise(() => {});
		state.units = [
			unitOf("idle", session("i1", { activity: "idle", updatedAt: at(15, 0) })),
			unitOf("asks", session("n1", { activity: "needs-you" })),
		];
		void digester.pump();
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(state.runs[0] ?? "", /State: needs-you/);
	});

	it("runs nothing while no board page is watching", async () => {
		const { state, digester } = await harness();
		state.watching = false;
		state.units = [unitOf("a", session("a1"))];
		await digester.pump();
		assert.equal(state.runs.length, 0);
	});

	it("keeps the old digest and pauses after a failure", async () => {
		const { state, digester } = await harness();
		state.units = [unitOf("a", session("a1"))];
		await digester.pump();
		state.units = [unitOf("a", session("a1", { doing: "Changed" }))];
		state.now += minIntervalMs;
		state.fail = true;
		await quietly(digester.pump);
		assert.equal(state.runs.length, 2);
		assert.equal(digester.current().projects.a?.narrative, "Narrative 1");
		state.fail = false;
		state.now += failurePauseMs - 1;
		await digester.pump();
		assert.equal(state.runs.length, 2);
		state.now += 1;
		await digester.pump();
		assert.equal(state.runs.length, 3);
		assert.equal(digester.current().projects.a?.narrative, "Narrative 3");
	});

	it("forgets frames that are no longer on the board", async () => {
		const { state, digester } = await harness();
		state.units = [unitOf("a", session("a1")), unitOf("b", session("b1"))];
		await digester.pump();
		state.units = [unitOf("a", session("a1"))];
		await digester.pump();
		assert.deepEqual(Object.keys(digester.current().projects), ["a"]);
		assert.deepEqual(Object.keys(state.changes.at(-1)?.projects ?? {}), ["a"]);
		assert.deepEqual(Object.keys(digester.current().sessions), ["a1"]);
	});

	it("does not rerun after a restart from the saved cache", async () => {
		const file = join(await mkdtemp(join(tmpdir(), "digests-")), "d.json");
		const first = await harness({}, file);
		first.state.units = [unitOf("a", session("a1"))];
		await first.digester.pump();
		await first.digester.saved();
		const second = await harness(await loadDigests(file), file);
		second.state.units = first.state.units;
		second.state.now += minIntervalMs;
		await second.digester.pump();
		assert.equal(second.state.runs.length, 0);
		assert.equal(
			second.digester.current().projects.a?.narrative,
			"Narrative 1",
		);
	});

	it("reads transcripts only for the frame it digests", async () => {
		const { state, digester } = await harness();
		state.units = [unitOf("a", session("a1")), unitOf("b", session("b1"))];
		await digester.pump();
		state.transcripts = [];
		state.units = [
			unitOf("a", session("a1")),
			unitOf("b", session("b1", { doing: "Changed" })),
		];
		state.now += minIntervalMs;
		await digester.pump();
		assert.deepEqual(state.transcripts, ["b1"]);
	});
});
