import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { RunnerJobResult } from "../shared/runners.ts";
import {
	ceilingOf,
	createJobRunner,
	mannersBlock,
	parseJobConfig,
} from "./jobs.ts";

const scratch = mkdtempSync(join(tmpdir(), "kanban-runner-jobs-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const usage = {
	cpus: 18,
	cpuPercent: 5,
	load1: 1,
	memTotal: 64e9,
	memUsed: 8e9,
	diskTotal: 1e12,
	diskFree: 8e11,
};

const config = (
	jobs: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) =>
	JSON.stringify({
		classes: Object.keys(jobs),
		jobs,
		limits: { cores: 8, memoryMb: 24576, slots: 2 },
		...extra,
	});

const runner = (text: string | null) => {
	const results: { id: string; attempt: number; result: RunnerJobResult }[] =
		[];
	const tmp = mkdtempSync(join(scratch, "tmp-"));
	let arrived: () => void = () => {};
	const jobs = createJobRunner({
		configFile: "unused",
		read: async () => text,
		tmp,
		home: scratch,
		platform: "linux",
		pressure: async () => false,
		log: () => {},
		post: async (id, attempt, result) => {
			results.push({ id, attempt, result });
			arrived();
		},
	});
	const next = () =>
		new Promise<void>((resolve) => {
			arrived = resolve;
		});
	return { jobs, results, tmp, next };
};

const job = (overrides: Record<string, unknown> = {}) => ({
	id: "job-1",
	class: "upper",
	attempt: 1,
	deadline: Date.now() + 30_000,
	input: Buffer.from("hello").toString("base64"),
	...overrides,
});

const state = { usage, signals: null, sessionsWorking: false };

describe("jobs on a runner", () => {
	it("refuses a class not on its own list, naming why", async () => {
		const { jobs, results, next } = runner(
			config({
				upper: { personal: false, command: ["/usr/bin/tr", "a-z", "A-Z"] },
			}),
		);
		await jobs.report(state);
		const posted = next();
		jobs.start(job({ class: "render" }));
		await posted;
		assert.equal(results[0]?.result.ok, false);
		assert.match(
			results[0]?.result.ok === false ? results[0].result.error : "",
			/render is not on this machine's list/,
		);
		assert.equal(
			results[0]?.result.ok === false && results[0].result.refused,
			true,
		);
	});

	it("refuses everything while its config lists no class", async () => {
		const { jobs, results, next } = runner(null);
		const report = await jobs.report(state);
		assert.equal(report.slotsFree, 0);
		assert.match(report.refusing ?? "", /lists no job class/);
		const posted = next();
		jobs.start(job());
		await posted;
		assert.equal(
			results[0]?.result.ok === false && results[0].result.refused,
			true,
		);
	});

	it("runs the class's fixed command on the input, in an empty environment and a scratch folder it wipes", async () => {
		const { jobs, results, tmp, next } = runner(
			config({
				upper: { personal: false, command: ["/usr/bin/tr", "a-z", "A-Z"] },
				env: { personal: false, command: ["/usr/bin/env"] },
			}),
		);
		await jobs.report(state);
		let posted = next();
		jobs.start(job());
		await posted;
		const first = results[0]?.result;
		assert.equal(first?.ok, true);
		assert.equal(
			Buffer.from(first?.ok ? first.output : "", "base64").toString(),
			"HELLO",
		);

		posted = next();
		jobs.start(job({ id: "job-2", class: "env" }));
		await posted;
		const env = Buffer.from(
			results[1]?.result.ok ? results[1].result.output : "",
			"base64",
		).toString();
		const names = env
			.trim()
			.split("\n")
			.map((line) => line.split("=")[0])
			.sort();
		assert.deepEqual(names, [
			"HOME",
			"KANBAN_JOB_ATTEMPT",
			"KANBAN_JOB_ID",
			"LANG",
			"PATH",
			"TMPDIR",
		]);
		assert.match(env, /HOME=.*kanban-job-/);
		assert.deepEqual(readdirSync(tmp), [], "its scratch folders are gone");
		assert.equal(jobs.busy(), false);
	});

	it("reports a failing command's exit and the end of what it said", async () => {
		const { jobs, results, next } = runner(
			config({
				fail: {
					personal: false,
					command: ["/bin/sh", "-c", "echo broke >&2; exit 3"],
				},
			}),
		);
		await jobs.report(state);
		const posted = next();
		jobs.start(job({ class: "fail" }));
		await posted;
		assert.equal(results[0]?.result.ok, false);
		assert.match(
			results[0]?.result.ok === false ? results[0].result.error : "",
			/exit 3: broke/,
		);
	});

	it("stops a job the hub no longer leases without sending a result", async () => {
		const { jobs, results } = runner(
			config({ wait: { personal: false, command: ["/bin/sleep", "20"] } }),
		);
		await jobs.report(state);
		jobs.start(job({ class: "wait" }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(jobs.busy(), true);
		jobs.stop(["job-1"], "the hub no longer leases it here");
		const until = Date.now() + 5_000;
		while (jobs.busy() && Date.now() < until) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(jobs.busy(), false);
		assert.deepEqual(results, []);
	});

	it("keeps under its ceiling, which halves while a board session works", async () => {
		const parsed = parseJobConfig(
			config({
				upper: { personal: false, command: ["/usr/bin/tr"], cores: 4 },
			}),
		);
		assert.deepEqual(ceilingOf(parsed, false), {
			cores: 8,
			memoryMb: 24576,
			slots: 2,
		});
		const polite = parseJobConfig(
			config(
				{ upper: { personal: false, command: ["/usr/bin/tr"] } },
				{ manners: { halveWhileSessionsWork: true } },
			),
		);
		assert.deepEqual(ceilingOf(polite, true), {
			cores: 4,
			memoryMb: 12288,
			slots: 1,
		});
	});

	it("takes no new job, and pauses running ones, while manners say so", async () => {
		const manners = parseJobConfig(
			config(
				{ upper: { personal: false, command: ["/usr/bin/tr"] } },
				{
					manners: {
						typedWithinSeconds: 120,
						battery: true,
						heat: true,
						memoryPressure: true,
						loadPerCore: 0.7,
					},
				},
			),
		).manners;
		const signals = {
			power: "mains" as const,
			batteryPercent: 100,
			lidOpen: true,
			thermal: "nominal" as const,
			idleSeconds: 600,
			sleepMinutes: 0,
			checkouts: [],
			allow: { classes: [], ceilings: {} },
			why: {},
		};
		const at = { usage, signals, pressured: false, sessionsWorking: false };
		assert.equal(mannersBlock(manners, at), null);
		assert.match(
			mannersBlock(manners, {
				...at,
				signals: { ...signals, idleSeconds: 30 },
			}) ?? "",
			/keyboard/,
		);
		assert.match(
			mannersBlock(manners, {
				...at,
				signals: { ...signals, power: "battery" },
			}) ?? "",
			/battery/,
		);
		assert.match(
			mannersBlock(manners, {
				...at,
				signals: { ...signals, thermal: "throttled" },
			}) ?? "",
			/hot/,
		);
		assert.match(
			mannersBlock(manners, { ...at, pressured: true }) ?? "",
			/pressure/,
		);
		assert.match(
			mannersBlock(manners, { ...at, usage: { ...usage, load1: 14 } }) ?? "",
			/load/,
		);

		const { jobs } = runner(
			config(
				{ wait: { personal: false, command: ["/bin/sleep", "20"] } },
				{ manners: { battery: true } },
			),
		);
		await jobs.report({ ...state, signals });
		jobs.start(job({ class: "wait" }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		const paused = await jobs.report({
			...state,
			signals: { ...signals, power: "battery" },
		});
		assert.equal(paused.running[0]?.paused, true);
		assert.equal(paused.slotsFree, 0);
		const resumed = await jobs.report({ ...state, signals });
		assert.equal(resumed.running[0]?.paused, false);
		jobs.stopAll("done");
	});

	it("refuses every job when its sandbox needs a Mac it isn't on", async () => {
		const { jobs } = runner(
			config(
				{ upper: { personal: false, command: ["/usr/bin/tr"] } },
				{
					sandbox: { profile: "/nix/store/x.sb", selfTest: "/nix/store/x.sh" },
				},
			),
		);
		const report = await jobs.report(state);
		assert.match(report.refusing ?? "", /sandbox/);
		assert.equal(
			existsSync(join(scratch, ".config", "kanban", "sandbox-canary")),
			false,
		);
	});
});

describe("stopping what a job left behind", () => {
	it("kills a job's whole process group at its deadline, even after its first process exited", async () => {
		const { jobs, results, next } = runner(
			config({
				stubborn: {
					personal: false,
					command: [
						"/bin/sh",
						"-c",
						"trap '' TERM; (trap '' TERM; sleep 30) & exit 0",
					],
				},
			}),
		);
		await jobs.report(state);
		const posted = next();
		jobs.start(job({ class: "stubborn", deadline: Date.now() + 300 }));
		await posted;
		assert.equal(results[0]?.result.ok, false);
		assert.equal(jobs.busy(), false);
	});
});
