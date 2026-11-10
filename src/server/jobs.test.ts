import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import type {
	RunnerCommand,
	RunnerJobsReport,
	RunnerReport,
} from "../shared/runners.ts";
import { compareShadow, readPng } from "./jobCompare.ts";
import { placeJob } from "./jobPlacement.ts";
import { createJobQueue, type JobSpec } from "./jobQueue.ts";
import { createJobsHttp, jobsOffFile } from "./jobsHttp.ts";
import { createRunnerKeys, parseRunnerAddresses } from "./runnerKeys.ts";
import { createRunnerHub } from "./runners.ts";

const scratch = mkdtempSync(join(tmpdir(), "kanban-jobs-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
const dbFile = () => join(scratch, `jobs-${++files}.sqlite`);

const usage = {
	cpus: 8,
	cpuPercent: 10,
	load1: 1,
	memTotal: 16e9,
	memUsed: 4e9,
	diskTotal: 500e9,
	diskFree: 100e9,
};

const jobsReport = (
	overrides: Partial<RunnerJobsReport> = {},
): RunnerJobsReport => ({
	classes: [{ name: "test", personal: false }],
	refusing: null,
	slotsFree: 2,
	running: [],
	...overrides,
});

const report = (
	name: string,
	overrides: Partial<RunnerReport> = {},
): RunnerReport => ({
	protocol: 3,
	name,
	hostname: name,
	platform: "darwin",
	arch: "arm64",
	release: "25",
	bootedAt: 1_000_000,
	cap: 4,
	usage,
	sessions: [],
	jobs: jobsReport(),
	...overrides,
});

const spec = (overrides: Partial<JobSpec> = {}): JobSpec => ({
	class: "test",
	input: Buffer.from("deadbeef"),
	personal: false,
	expectedMs: 30_000,
	deadlineMs: 3600_000,
	maxAttempts: 3,
	source: "test",
	shadow: null,
	reference: null,
	...overrides,
});

// A hub with the real queue on disk, a clock the test moves, and runners the
// test plays: it registers them, reads the commands the hub queued for them
// and sends their heartbeats and results.
const setup = (
	options: {
		file?: string;
		plainOnly?: string[];
		updateLast?: string[];
		runnerVersion?: string;
		off?: () => boolean;
		at?: { now: number };
	} = {},
) => {
	const clock = options.at ?? { now: 10_000_000 };
	const file = options.file ?? dbFile();
	const lines: string[] = [];
	const queue = createJobQueue({
		file,
		now: () => clock.now,
		log: (line) => lines.push(line),
		compare: compareShadow,
	});
	let ids = 0;
	const hub = createRunnerHub({
		now: () => clock.now,
		hubHome: "/home/spike",
		local: () => ({ name: "spike", usage, cap: 0, sessions: [] }),
		onChange: () => {},
		newId: () => `c${++ids}`,
		jobs: queue,
		jobsOff: options.off ?? (() => false),
		plainOnly: options.plainOnly ?? [],
		updateLast: options.updateLast ?? [],
		runnerVersion: () => options.runnerVersion ?? null,
	});
	const commandsFor = async (id: string): Promise<RunnerCommand[]> =>
		(await hub.poll(id, 0)) ?? [];
	const jobsFor = async (id: string) =>
		(await commandsFor(id)).flatMap((command) =>
			command.type === "job" ? [command.job] : [],
		);
	return {
		clock,
		file,
		queue,
		hub,
		lines,
		jobsFor,
		advance(ms: number) {
			clock.now += ms;
			hub.sweep();
		},
		close() {
			hub.stopAll();
			queue.close();
		},
	};
};

describe("the job queue with simulated runners", () => {
	it("leases a job to a runner that lists its class and takes its result", async () => {
		const t = setup();
		t.hub.register(report("piggy"));
		t.queue.submit(spec());
		t.hub.dispatch();
		const [job] = await t.jobsFor("piggy");
		assert.ok(job);
		assert.equal(job.attempt, 1);
		assert.equal(Buffer.from(job.input, "base64").toString(), "deadbeef");
		assert.equal(
			t.hub.jobResult("piggy", job.id, 1, { ok: true, output: "", ms: 5 }),
			"accepted",
		);
		assert.equal(t.queue.counts().done, 1);
		t.close();
	});

	it("never places a job on a runner whose config doesn't list its class", async () => {
		const t = setup();
		t.hub.register(
			report("piggy", {
				jobs: jobsReport({ classes: [{ name: "render", personal: true }] }),
			}),
		);
		t.queue.submit(spec());
		t.hub.dispatch();
		assert.deepEqual(await t.jobsFor("piggy"), []);
		assert.equal(t.queue.counts().queued, 1);
		t.close();
	});

	it("requeues a refused job with the next attempt and keeps it off the runner that refused", async () => {
		const t = setup();
		t.hub.register(report("piggy"));
		t.queue.submit(spec());
		t.hub.dispatch();
		const [job] = await t.jobsFor("piggy");
		assert.ok(job);
		t.hub.jobResult("piggy", job.id, 1, {
			ok: false,
			error: "test is not on this machine's list of job classes",
			ms: 0,
			refused: true,
		});
		const [waiting] = t.queue.waiting();
		assert.equal(waiting?.attempt, 2);
		assert.deepEqual(waiting?.excluded, ["piggy"]);
		t.hub.dispatch();
		assert.deepEqual(await t.jobsFor("piggy"), []);
		t.close();
	});

	it("lapses a lease after 15 s of silence and requeues the job with a new attempt", async () => {
		const t = setup();
		t.hub.register(report("pilot"));
		t.queue.submit(spec());
		t.hub.dispatch();
		const [job] = await t.jobsFor("pilot");
		assert.ok(job);
		t.advance(10_000);
		t.hub.heartbeat(
			"pilot",
			report("pilot", {
				jobs: jobsReport({
					running: [{ id: job.id, attempt: 1, paused: false }],
				}),
			}),
		);
		t.advance(10_000);
		assert.equal(t.queue.counts().leased, 1, "a heartbeat renewed it");
		t.advance(16_000);
		const [row] = t.queue.recent();
		assert.equal(row?.attempt, 2);
		assert.ok(
			t.lines.some((line) => line.includes("requeued as attempt 2")),
			t.lines.join("\n"),
		);
		t.close();
	});

	it("drops a late result from the old attempt", async () => {
		const t = setup();
		t.hub.register(report("pilot"));
		t.hub.register(report("piggy"));
		t.queue.submit(spec());
		t.hub.dispatch();
		const first = [
			...(await t.jobsFor("piggy")),
			...(await t.jobsFor("pilot")),
		][0];
		assert.ok(first);
		t.advance(16_000);
		t.hub.heartbeat("piggy", report("piggy"));
		t.hub.heartbeat("pilot", report("pilot"));
		const second = [
			...(await t.jobsFor("piggy")),
			...(await t.jobsFor("pilot")),
		][0];
		assert.equal(second?.attempt, 2);
		const holder = t.queue.recent()[0]?.leaseHolder ?? "";
		const old = holder === "piggy" ? "pilot" : "piggy";
		assert.equal(
			t.hub.jobResult(old, first.id, 1, { ok: true, output: "", ms: 1 }),
			"late",
		);
		assert.equal(
			t.hub.jobResult(holder, first.id, 1, { ok: true, output: "", ms: 1 }),
			"late",
		);
		assert.equal(t.queue.counts().leased, 1);
		assert.equal(
			t.hub.jobResult(holder, first.id, 2, { ok: true, output: "", ms: 1 }),
			"accepted",
		);
		t.close();
	});

	it("tells a runner to stop a job it no longer leases", async () => {
		const t = setup();
		t.hub.register(report("pilot"));
		const reply = t.hub.heartbeat(
			"pilot",
			report("pilot", {
				jobs: jobsReport({
					running: [{ id: "gone", attempt: 1, paused: false }],
				}),
			}),
		);
		assert.deepEqual(reply, { ok: true, stopJobs: ["gone"] });
		t.close();
	});

	it("keeps the queue and its leases across a hub restart", async () => {
		const clock = { now: 10_000_000 };
		const before = setup({ at: clock });
		before.hub.register(report("pilot"));
		before.queue.submit(spec());
		before.queue.submit(spec());
		before.hub.dispatch();
		const leased = await before.jobsFor("pilot");
		assert.equal(leased.length, 2);
		before.close();

		clock.now += 3_000;
		const afterRestart = setup({ at: clock, file: before.file });
		assert.equal(afterRestart.queue.counts().leased, 2);
		const kept = leased[0];
		assert.ok(kept);
		afterRestart.hub.register(
			report("pilot", {
				jobs: jobsReport({
					running: [{ id: kept.id, attempt: 1, paused: false }],
				}),
			}),
		);
		afterRestart.hub.heartbeat(
			"pilot",
			report("pilot", {
				jobs: jobsReport({
					running: [{ id: kept.id, attempt: 1, paused: false }],
				}),
			}),
		);
		afterRestart.advance(10_000);
		afterRestart.hub.heartbeat(
			"pilot",
			report("pilot", {
				jobs: jobsReport({
					running: [{ id: kept.id, attempt: 1, paused: false }],
					slotsFree: 0,
				}),
			}),
		);
		afterRestart.advance(10_000);
		const rows = afterRestart.queue.recent();
		const reported = rows.find((row) => row.id === kept.id);
		const lost = rows.find((row) => row.id !== kept.id);
		assert.equal(reported?.state, "leased");
		assert.equal(reported?.attempt, 1);
		assert.equal(lost?.state, "queued");
		assert.equal(lost?.attempt, 2);
		assert.equal(
			afterRestart.hub.jobResult("pilot", kept.id, 1, {
				ok: true,
				output: "",
				ms: 1,
			}),
			"accepted",
		);
		afterRestart.close();
	});

	it("never places a personal job on a plain-only runner, whatever its config lists", async () => {
		const t = setup({ plainOnly: ["pilot"] });
		t.hub.register(
			report("pilot", {
				jobs: jobsReport({
					classes: [
						{ name: "render", personal: false },
						{ name: "notes", personal: true },
					],
				}),
			}),
		);
		t.queue.submit(spec({ class: "render", personal: true }));
		t.queue.submit(spec({ class: "notes", personal: false }));
		t.hub.dispatch();
		assert.deepEqual(await t.jobsFor("pilot"), []);
		assert.equal(t.queue.counts().queued, 2);
		t.close();
	});

	it("places nothing while the off-switch is set, and refuses new jobs", async () => {
		let off = true;
		const t = setup({ off: () => off });
		t.hub.register(report("piggy"));
		t.queue.submit(spec());
		t.hub.dispatch();
		assert.deepEqual(await t.jobsFor("piggy"), []);
		off = false;
		t.hub.dispatch();
		assert.equal((await t.jobsFor("piggy")).length, 1);

		const stateDir = mkdtempSync(join(scratch, "state-"));
		writeFileSync(jobsOffFile(stateDir), "");
		const http = createJobsHttp({
			queue: t.queue,
			offFile: jobsOffFile(stateDir),
			runners: () => t.hub.views(),
		});
		const refused = http.submit({ class: "test", input: "" });
		assert.equal(refused.ok, false);
		assert.equal((http.view() as { off: boolean }).off, true);
		t.close();
	});

	it("gives a runner just back short work at once and long work after a minute", () => {
		const candidate = {
			id: "pilot",
			online: true,
			onlineSince: 1_000_000,
			jobs: jobsReport(),
			plainOnly: false,
			enrolled: true,
			loadPerCpu: 0.1,
			drops: null,
		};
		const long = {
			class: "test",
			personal: false,
			expectedMs: 5 * 60_000,
			excluded: [],
		};
		assert.equal(
			placeJob({ ...long, expectedMs: 30_000 }, [candidate], 1_010_000).runner,
			"pilot",
		);
		assert.equal(placeJob(long, [candidate], 1_010_000).runner, null);
		assert.equal(placeJob(long, [candidate], 1_061_000).runner, "pilot");
	});

	it("sends long work to the runner that usually stays up at this hour", () => {
		const day = 86_400_000;
		const flaky = {
			id: "pilot",
			online: true,
			onlineSince: 0,
			jobs: jobsReport({ slotsFree: 4 }),
			plainOnly: false,
			enrolled: true,
			loadPerCpu: 0.1,
			drops: {
				since: 0,
				byHour: Array.from({ length: 24 }, (_, hour) => (hour === 21 ? 70 : 0)),
				total: 70,
				recent: [],
			},
		};
		const steady = {
			...flaky,
			id: "piggy",
			jobs: jobsReport({ slotsFree: 1 }),
			drops: null,
		};
		const long = {
			class: "test",
			personal: false,
			expectedMs: 20 * 60_000,
			excluded: [],
		};
		assert.equal(placeJob(long, [flaky, steady], 7 * day, 21).runner, "piggy");
		assert.equal(placeJob(long, [flaky], 7 * day, 21).runner, null);
		assert.equal(placeJob(long, [flaky, steady], 7 * day, 10).runner, "pilot");
	});
});

describe("staged runner updates", () => {
	it("tells the updated-last runner of a new runner.js only after the others ran it cleanly for 10 minutes and it holds no lease", async () => {
		const served = "a".repeat(64);
		const old = "b".repeat(64);
		const t = setup({ updateLast: ["pilot"], runnerVersion: served });
		const piggy = t.hub.register(report("piggy", { version: old }));
		assert.equal(piggy.ok && piggy.runnerVersion, served);
		const pilot = t.hub.register(report("pilot", { version: old }));
		assert.equal(pilot.ok && pilot.runnerVersion, undefined);

		t.advance(4_000);
		t.hub.heartbeat("piggy", report("piggy", { version: served }));
		for (let beat = 0; beat < 120; beat++) {
			t.advance(5_000);
			t.hub.heartbeat("piggy", report("piggy", { version: served }));
			const reply = t.hub.heartbeat("pilot", report("pilot", { version: old }));
			if (beat < 115) {
				assert.equal(
					(reply as { runnerVersion?: string }).runnerVersion,
					undefined,
					`beat ${beat}`,
				);
			}
		}
		const ready = t.hub.heartbeat("pilot", report("pilot", { version: old }));
		assert.equal((ready as { runnerVersion?: string }).runnerVersion, served);

		t.hub.heartbeat(
			"piggy",
			report("piggy", { version: served, jobs: jobsReport({ classes: [] }) }),
		);
		t.queue.submit(spec());
		t.hub.dispatch();
		const [held] = await t.jobsFor("pilot");
		assert.ok(held);
		const busy = t.hub.heartbeat(
			"pilot",
			report("pilot", {
				version: old,
				jobs: jobsReport({
					running: [{ id: held.id, attempt: 1, paused: false }],
				}),
			}),
		);
		assert.equal((busy as { runnerVersion?: string }).runnerVersion, undefined);
		const view = t.hub.views().find((runner) => runner.id === "pilot");
		assert.ok(view?.update);
		t.close();
	});

	it("says in the hub's view when a runner is too old to update itself", () => {
		const t = setup({ runnerVersion: "a".repeat(64) });
		t.hub.register(report("jimbo", { protocol: 1, jobs: undefined }));
		const view = t.hub.views().find((runner) => runner.id === "jimbo");
		assert.match(view?.update ?? "", /restart kanban-runner on jimbo/);
		t.close();
	});
});

const requestWith = (
	token: string | null,
	forwarded: string | null = null,
): IncomingMessage =>
	({
		headers: {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(forwarded ? { "cf-connecting-ip": forwarded } : {}),
		},
		socket: { remoteAddress: "127.0.0.1" },
	}) as unknown as IncomingMessage;

describe("a token per runner", () => {
	const shared = "s".repeat(40);
	const pilotSecret = "p".repeat(43);
	const piggySecret = "g".repeat(43);
	const hash = (text: string) =>
		createHash("sha256").update(text).digest("hex");
	const keysIn = () =>
		createRunnerKeys({
			file: join(mkdtempSync(join(scratch, "keys-")), "runner-keys.json"),
			sharedToken: shared,
			addresses: parseRunnerAddresses(
				"pilot=10.100.0.11, piggy=10.100.0.2, jimbo=10.100.0.12",
			),
		});

	it("accepts the shared token for a name that has not enrolled", () => {
		const keys = keysIn();
		assert.equal(keys.mayActAs(requestWith(shared), "jimbo"), null);
		assert.equal(keys.state("jimbo"), "shared-token");
	});

	it("refuses an enrolled name the shared token, and accepts its own secret", () => {
		const keys = keysIn();
		assert.deepEqual(keys.enrol("pilot", hash(pilotSecret), "10.100.0.11"), {
			ok: true,
			already: false,
		});
		assert.match(keys.mayActAs(requestWith(shared), "pilot") ?? "", /enrolled/);
		assert.equal(keys.mayActAs(requestWith(pilotSecret), "pilot"), null);
		assert.equal(keys.state("pilot"), "enrolled");
	});

	it("refuses a name enrolling from the wrong address", () => {
		const keys = keysIn();
		const refused = keys.enrol("pilot", hash(pilotSecret), "10.100.0.2");
		assert.equal(refused.ok, false);
		assert.equal(keys.enrol("pilot", hash(pilotSecret), null).ok, false);
		assert.equal(keys.state("pilot"), "shared-token");
	});

	it("never lets one runner's secret act as another", () => {
		const keys = keysIn();
		keys.enrol("pilot", hash(pilotSecret), "10.100.0.11");
		keys.enrol("piggy", hash(piggySecret), "10.100.0.2");
		assert.match(
			keys.mayActAs(requestWith(pilotSecret), "piggy") ?? "",
			/can't act as piggy/,
		);
		assert.match(
			keys.mayActAs(requestWith(piggySecret), "pilot") ?? "",
			/can't act as pilot/,
		);
		assert.match(
			keys.mayActAs(requestWith(pilotSecret), "jimbo") ?? "",
			/can't act as jimbo/,
		);
	});

	it("refuses a second secret for an enrolled name, and cuts off a name set to null", () => {
		const dir = mkdtempSync(join(scratch, "keys-"));
		const file = join(dir, "runner-keys.json");
		const keys = createRunnerKeys({
			file,
			sharedToken: shared,
			addresses: parseRunnerAddresses("pilot=10.100.0.11"),
		});
		keys.enrol("pilot", hash(pilotSecret), "10.100.0.11");
		assert.equal(
			keys.enrol("pilot", hash(piggySecret), "10.100.0.11").ok,
			false,
		);
		writeFileSync(file, JSON.stringify({ pilot: null }));
		const fresh = createRunnerKeys({
			file,
			sharedToken: shared,
			addresses: parseRunnerAddresses("pilot=10.100.0.11"),
		});
		assert.equal(fresh.state("pilot"), "cut-off");
		assert.ok(fresh.mayActAs(requestWith(pilotSecret), "pilot"));
		assert.ok(fresh.mayActAs(requestWith(shared), "pilot"));
		assert.equal(
			fresh.enrol("pilot", hash(pilotSecret), "10.100.0.11").ok,
			false,
		);
	});
});

const png = (
	width: number,
	height: number,
	pixel: (x: number, y: number) => number,
) => {
	const rows: number[] = [];
	for (let y = 0; y < height; y++) {
		rows.push(0);
		for (let x = 0; x < width; x++) {
			const value = pixel(x, y);
			rows.push(value, value, value);
		}
	}
	const chunk = (type: string, body: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(body.length, 0);
		head.write(type, 4, "latin1");
		return Buffer.concat([head, body, Buffer.alloc(4)]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
};

describe("shadow comparison", () => {
	const left = png(64, 48, (x) => (x < 32 ? 0 : 255));
	it("reads a picture's size", () => {
		assert.deepEqual(
			{ width: readPng(left)?.width, height: readPng(left)?.height },
			{ width: 64, height: 48 },
		);
	});
	it("matches the same picture and a near one, and not another", () => {
		assert.equal(compareShadow("png", left, left).match, true);
		const near = png(64, 48, (x, y) => (x < 32 ? (y === 0 ? 30 : 0) : 255));
		assert.equal(compareShadow("png", near, left).match, true);
		const flipped = png(64, 48, (x) => (x < 32 ? 255 : 0));
		assert.equal(compareShadow("png", flipped, left).match, false);
		assert.match(
			compareShadow(
				"png",
				png(32, 48, () => 0),
				left,
			).detail,
			/size/,
		);
	});
	it("compares a test run by whether it passed", () => {
		const pass = Buffer.from(JSON.stringify({ pass: true }));
		assert.equal(compareShadow("test", pass, null).match, true);
		assert.equal(
			compareShadow("test", pass, Buffer.from(JSON.stringify({ pass: false })))
				.match,
			false,
		);
	});
	it("logs a shadow's verdict and both times", async () => {
		const t = setup();
		t.hub.register(report("piggy"));
		t.queue.submit(
			spec({ shadow: { kind: "png", referenceMs: 900 }, reference: left }),
		);
		t.hub.dispatch();
		const [job] = await t.jobsFor("piggy");
		assert.ok(job);
		t.hub.jobResult("piggy", job.id, 1, {
			ok: true,
			output: left.toString("base64"),
			ms: 1200,
		});
		const [entry] = t.queue.shadows();
		assert.equal(entry?.match, true);
		assert.equal(entry?.runnerMs, 1200);
		assert.equal(entry?.referenceMs, 900);
		assert.ok(t.lines.some((line) => line.startsWith("jobs: shadow test")));
		t.close();
	});
});

describe("what the review found", () => {
	const shared = "s".repeat(40);
	it("fails closed on a keys file it can't read", () => {
		const dir = mkdtempSync(join(scratch, "keys-"));
		const file = join(dir, "runner-keys.json");
		writeFileSync(file, '{"pilot": "' + "a".repeat(64) + '",}');
		const keys = createRunnerKeys({
			file,
			sharedToken: shared,
			addresses: parseRunnerAddresses("pilot=10.100.0.11"),
		});
		assert.ok(keys.mayActAs(requestWith(shared), "pilot"));
		assert.ok(keys.mayActAs(requestWith(shared), "jimbo"));
		assert.equal(keys.enrol("pilot", "b".repeat(64), "10.100.0.11").ok, false);
	});

	it("reads an unreadable entry as cut off rather than dropping it", () => {
		const dir = mkdtempSync(join(scratch, "keys-"));
		const file = join(dir, "runner-keys.json");
		writeFileSync(file, JSON.stringify({ pilot: "cut" }));
		const keys = createRunnerKeys({
			file,
			sharedToken: shared,
			addresses: new Map(),
		});
		assert.equal(keys.state("pilot"), "cut-off");
	});

	it("lets the shared token speak for a runner with a known address only from that address", () => {
		const keys = createRunnerKeys({
			file: join(mkdtempSync(join(scratch, "keys-")), "runner-keys.json"),
			sharedToken: shared,
			addresses: parseRunnerAddresses("jimbo=10.100.0.12"),
		});
		assert.equal(
			keys.mayActAs(requestWith(shared, "10.100.0.12"), "jimbo"),
			null,
		);
		assert.ok(keys.mayActAs(requestWith(shared, "10.100.0.11"), "jimbo"));
	});

	it("gives personal work only to a runner that enrolled its own secret", () => {
		const candidate = {
			id: "piggy",
			online: true,
			onlineSince: 0,
			jobs: jobsReport({ classes: [{ name: "render", personal: true }] }),
			plainOnly: false,
			enrolled: false,
			loadPerCpu: 0.1,
			drops: null,
		};
		const render = {
			class: "render",
			personal: true,
			expectedMs: 10_000,
			excluded: [],
		};
		assert.equal(placeJob(render, [candidate], 1e9).runner, null);
		assert.equal(
			placeJob(render, [{ ...candidate, enrolled: true }], 1e9).runner,
			"piggy",
		);
	});

	it("leases no more jobs than a runner has free slots, before its next heartbeat", async () => {
		const t = setup();
		t.hub.register(report("piggy", { jobs: jobsReport({ slotsFree: 1 }) }));
		t.queue.submit(spec());
		t.queue.submit(spec());
		t.hub.dispatch();
		t.hub.dispatch();
		t.advance(5_000);
		assert.equal((await t.jobsFor("piggy")).length, 1);
		t.close();
	});

	it("requeues a job a runner handed back without keeping it off that runner", async () => {
		const t = setup();
		t.hub.register(report("piggy"));
		t.queue.submit(spec());
		t.hub.dispatch();
		const [job] = await t.jobsFor("piggy");
		assert.ok(job);
		t.hub.jobResult("piggy", job.id, 1, {
			ok: false,
			error: "on battery",
			ms: 0,
			requeue: true,
		});
		const [again] = await t.jobsFor("piggy");
		assert.equal(again?.attempt, 2, "it goes back to the same runner");
		t.close();
	});

	it("sends an older updated-last runner back to register once, since it reads the version only then", () => {
		const t = setup({ updateLast: ["pilot"], runnerVersion: "a".repeat(64) });
		t.hub.register(report("pilot", { protocol: 2, jobs: undefined }));
		t.advance(11 * 60_000);
		assert.equal(
			t.hub.heartbeat(
				"pilot",
				report("pilot", { protocol: 2, jobs: undefined }),
			),
			"unknown",
		);
		const again = t.hub.register(
			report("pilot", { protocol: 2, jobs: undefined }),
		);
		assert.equal(again.ok && again.runnerVersion, "a".repeat(64));
		assert.notEqual(
			t.hub.heartbeat(
				"pilot",
				report("pilot", { protocol: 2, jobs: undefined }),
			),
			"unknown",
		);
		t.close();
	});
});
