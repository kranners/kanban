import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunnerReport, RunnerSession } from "../shared/runners.ts";
import type { Session } from "../shared/types.ts";
import { createRunnerHub, parseRunnerReport } from "./runners.ts";

const usage = {
	cpus: 8,
	cpuPercent: 25,
	load1: 1.5,
	memTotal: 16e9,
	memUsed: 8e9,
	diskTotal: 500e9,
	diskFree: 100e9,
};

const report = (overrides: Partial<RunnerReport> = {}): RunnerReport => ({
	protocol: 1,
	name: "jimbo",
	hostname: "jimbo.lan",
	platform: "linux",
	arch: "x64",
	release: "6.1",
	bootedAt: 1_000_000,
	cap: 2,
	usage,
	sessions: [],
	...overrides,
});

const running = (id: string, state: RunnerSession["state"] = "working") => ({
	id,
	cwd: "/Users/aaron/code/acme",
	localCwd: "/home/aaron/code/acme",
	name: `acme ${id}`,
	state,
	detail: "Bash: npm test",
	startedAt: 10,
	updatedAt: 20,
	endedAt: state === "working" ? null : 30,
	claudeSessionId: null,
	cpuPercent: 12,
	rss: 300e6,
});

const setup = (expected: string[] = []) => {
	let at = 5_000_000;
	let changes = 0;
	let ids = 0;
	const hub = createRunnerHub({
		now: () => at,
		expected,
		hubHome: "/Users/aaron",
		local: () => ({
			name: "pilot",
			usage,
			cap: 4,
			sessions: [],
		}),
		onChange: () => {
			changes += 1;
		},
		commandTimeoutMs: 50,
		newId: () => `id-${++ids}`,
	});
	return {
		hub,
		advance: (ms: number) => {
			at += ms;
		},
		changes: () => changes,
	};
};

const sessionOn = (id: string, runner: string): Session =>
	({ id, runner: { id: runner, name: runner } }) as Session;

describe("parseRunnerReport", () => {
	it("accepts a well-formed report and refuses junk", () => {
		assert.deepEqual(parseRunnerReport(report()), report());
		assert.equal(parseRunnerReport({ ...report(), name: "" }), null);
		assert.equal(parseRunnerReport({ ...report(), usage: null }), null);
		assert.equal(
			parseRunnerReport({ ...report(), sessions: [{ id: "../x" }] }),
			null,
		);
		assert.equal(parseRunnerReport("nope"), null);
	});
});

describe("createRunnerHub", () => {
	it("lists this Mac first, then machines by state", () => {
		const { hub } = setup(["spike", "jimbo"]);
		const views = hub.views();
		assert.deepEqual(
			views.map((view) => [view.id, view.label, view.state, view.lastSeen]),
			[
				["local", "This Mac", "online", 5_000_000],
				["jimbo", "jimbo", "offline", null],
				["spike", "spike", "offline", null],
			],
		);
		assert.equal(views[0]?.runsOn, "local");
		assert.equal(views[1]?.runsOn, "runner_jimbo");
	});

	it("registers a runner and keeps its usage and allocation", () => {
		const { hub } = setup();
		const registered = hub.register(
			report({ name: "Jimbo Linux", sessions: [running("s1")] }),
		);
		assert.deepEqual(registered, {
			ok: true,
			id: "jimbo-linux",
			heartbeatMs: 5000,
			pollWaitMs: 25000,
		});
		const view = hub.views()[1];
		assert.equal(view?.state, "online");
		assert.equal(view?.label, "Jimbo Linux");
		assert.deepEqual(view?.usage, usage);
		assert.equal(view?.cap, 2);
		assert.deepEqual(view?.sessions, [
			{
				id: "s1",
				name: "acme s1",
				cwd: "/Users/aaron/code/acme",
				activity: "working",
				cpuPercent: 12,
				rss: 300e6,
			},
		]);
		assert.equal(
			hub.register(report({ name: "local" })).ok,
			false,
			"local is the hub's own",
		);
	});

	it("puts its sessions on the board in their hub folder", () => {
		const { hub } = setup();
		hub.register(report({ sessions: [running("s1"), running("s2", "done")] }));
		const sessions = hub.sessions();
		assert.deepEqual(
			sessions.map((s) => [s.id, s.cwd, s.project, s.activity, s.runner?.id]),
			[
				["s1", "/Users/aaron/code/acme", "acme", "working", "jimbo"],
				["s2", "/Users/aaron/code/acme", "acme", "done", "jimbo"],
			],
		);
		assert.equal(sessions[0]?.doing, "Bash: npm test");
	});

	it("marks a silent runner offline, or asleep when it last came back from sleep", () => {
		const { hub, advance, changes } = setup();
		hub.register(report({ sessions: [running("s1")] }));
		advance(10_000);
		hub.sweep();
		assert.equal(hub.views()[1]?.state, "online");
		const before = changes();
		advance(6_000);
		hub.sweep();
		assert.equal(changes(), before + 1);
		const gone = hub.views()[1];
		assert.equal(gone?.state, "offline");
		assert.equal(gone?.goneSince, 5_000_000);
		assert.equal(gone?.usage, null);
		assert.equal(hub.sessions()[0]?.activity, "idle");
		assert.equal(hub.sessions()[0]?.doing, "jimbo is offline");
		assert.equal(hub.blocker("runner_jimbo"), "jimbo is offline");
		// Back with the same boot time: it slept, so next silence reads asleep.
		assert.equal(hub.heartbeat("jimbo", report()), "ok");
		advance(20_000);
		hub.sweep();
		assert.equal(hub.views()[1]?.state, "asleep");
		// Back after a reboot: off, not asleep.
		hub.heartbeat("jimbo", report({ bootedAt: 9_000_000 }));
		advance(20_000);
		hub.sweep();
		assert.equal(hub.views()[1]?.state, "offline");
	});

	it("asks an unknown runner to register again", () => {
		const { hub } = setup(["spike"]);
		assert.equal(hub.heartbeat("jimbo", report()), "unknown");
		assert.equal(hub.heartbeat("spike", report({ name: "spike" })), "unknown");
		hub.register(report());
		assert.equal(hub.heartbeat("jimbo", report({ name: "other" })), "unknown");
		assert.deepEqual(hub.heartbeat("jimbo", { name: "jimbo" }), {
			error: "Malformed runner report",
		});
	});

	it("launches through the runner's poll and lands with the hub's id", async () => {
		const { hub } = setup();
		hub.register(report());
		const polled = hub.poll("jimbo", 1_000);
		const launched = hub.launch({
			cwd: "/Users/aaron/code/acme",
			prompt: "fix it",
			runsOn: "runner_jimbo",
		});
		const [command] = (await polled) ?? [];
		assert.deepEqual(command, {
			type: "launch",
			commandId: "id-2",
			session: {
				id: "id-1",
				cwd: "/Users/aaron/code/acme",
				prompt: "fix it",
				name: "acme",
			},
			hubHome: "/Users/aaron",
		});
		assert.equal(
			hub.sessions()[0]?.activity,
			"working",
			"shown while it starts",
		);
		assert.equal(hub.complete("other", "id-2", { ok: true }), false);
		assert.equal(hub.complete("jimbo", "id-2", { ok: true }), true);
		assert.deepEqual(await launched, { ok: true, id: "id-1" });
	});

	it("passes on a runner's refusal and gives up on a silent one", async () => {
		const { hub } = setup();
		hub.register(report());
		const refused = hub.launch({
			cwd: "/x",
			prompt: "p",
			runsOn: "runner_jimbo",
		});
		const [command] = (await hub.poll("jimbo", 10)) ?? [];
		hub.complete("jimbo", command?.commandId ?? "", {
			ok: false,
			error: "/x isn't a directory on this machine",
		});
		assert.deepEqual(await refused, {
			ok: false,
			error: "/x isn't a directory on this machine",
		});
		assert.equal(hub.sessions().length, 0);
		assert.deepEqual(
			await hub.launch({ cwd: "/x", prompt: "p", runsOn: "runner_jimbo" }),
			{ ok: false, error: "jimbo didn't answer" },
		);
	});

	it("keeps a command for the next poll when the runner hung up", async () => {
		const { hub } = setup();
		hub.register(report());
		const launched = hub.launch({
			cwd: "/x",
			prompt: "p",
			runsOn: "runner_jimbo",
		});
		const first = (await hub.poll("jimbo", 10)) ?? [];
		hub.requeue("jimbo", first);
		const again = (await hub.poll("jimbo", 10)) ?? [];
		assert.deepEqual(again, first);
		hub.complete("jimbo", again[0]?.commandId ?? "", { ok: true });
		assert.equal((await launched).ok, true);
	});

	it("refuses placements on machines that are off, unknown or full", async () => {
		const { hub } = setup(["spike"]);
		assert.equal(
			hub.blocker("runner_spike"),
			"This machine hasn't checked in yet",
		);
		assert.equal(
			hub.blocker("runner_nope"),
			"This machine hasn't checked in yet",
		);
		hub.register(report({ sessions: [running("s1"), running("s2")] }));
		assert.equal(hub.blocker("runner_jimbo"), "jimbo is at its cap (2 of 2)");
		assert.deepEqual(
			await hub.launch({ cwd: "/x", prompt: "p", runsOn: "runner_jimbo" }),
			{ ok: false, error: "jimbo is at its cap (2 of 2)" },
		);
		assert.equal((await hub.poll("jimbo", 0))?.length, 0);
		assert.equal(await hub.poll("nope", 0), null);
	});

	it("stops a session on its runner", async () => {
		const { hub, advance } = setup();
		hub.register(report({ sessions: [running("s1")] }));
		const stopped = hub.stop(sessionOn("s1", "jimbo"), true);
		const [command] = (await hub.poll("jimbo", 10)) ?? [];
		assert.deepEqual(command, {
			type: "stop",
			commandId: "id-1",
			sessionId: "s1",
			force: true,
		});
		hub.complete("jimbo", "id-1", { ok: true });
		assert.deepEqual(await stopped, { ok: true, exited: true });
		advance(60_000);
		hub.sweep();
		assert.deepEqual(await hub.stop(sessionOn("s1", "jimbo"), false), {
			ok: false,
			error: "jimbo is offline",
		});
	});
});
