import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunnerReport, RunnerSession } from "../shared/runners.ts";
import type { FolderListing, Session } from "../shared/types.ts";
import { createRunnerHub, parseListing, parseRunnerReport } from "./runners.ts";

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

const setup = (
	expected: string[] = [],
	options: Partial<Parameters<typeof createRunnerHub>[0]> = {},
) => {
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
		browseTimeoutMs: 50,
		newId: () => `id-${++ids}`,
		...options,
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
		const { hub } = setup(["spike", "jimbo"], { platform: "darwin" });
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

	it("tells each runner the version of the runner.js it serves", () => {
		const { hub } = setup([], { runnerVersion: () => "abc123" });
		const registered = hub.register(report());
		assert.equal(registered.ok && registered.runnerVersion, "abc123");
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

	it("puts its sessions' subagents on the board, dropping a malformed list", () => {
		const { hub, advance } = setup();
		const subagents = [
			{
				id: "toolu_a",
				description: "Read the tests",
				type: "Explore",
				state: "working",
				startedAt: 11,
				updatedAt: 12,
			},
			{
				id: "toolu_b",
				description: "Plan",
				type: "workflow",
				state: "done",
				parent: "toolu_a",
				updatedAt: 15,
			},
		];
		hub.register(
			report({
				sessions: [
					{ ...running("s1"), subagents },
					{ ...running("s2"), subagents: [{ id: "bad id" }] },
					running("s3"),
				],
			} as unknown as Partial<RunnerReport>),
		);
		assert.deepEqual(hub.subagents(), [
			{
				id: "toolu_a",
				kind: "agent",
				sessionId: "s1",
				parentAgentId: null,
				type: "Explore",
				description: "Read the tests",
				live: true,
				done: false,
				startedAt: 11,
				updatedAt: 12,
			},
			{
				id: "toolu_b",
				kind: "agent",
				sessionId: "s1",
				parentAgentId: "toolu_a",
				type: "workflow",
				description: "Plan",
				live: false,
				done: true,
				startedAt: 15,
				updatedAt: 15,
			},
		]);
		assert.equal(hub.sessions().length, 3);
		advance(20_000);
		hub.sweep();
		assert.equal(hub.subagents()[0]?.live, false);
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
			error: "/x isn't a directory on jimbo",
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
		assert.match(
			hub.blocker("runner_spike") ?? "",
			/^spike's runner hasn't connected to the board/,
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

	it("calls a Linux hub by its machine name, not This Mac", () => {
		const { hub } = setup([], { platform: "linux" });
		assert.equal(hub.localLabel(), "pilot");
		assert.equal(hub.views()[0]?.label, "pilot");
		assert.equal(
			setup([], { platform: "darwin" }).hub.localLabel(),
			"This Mac",
		);
	});
});

const listing = (overrides: Partial<FolderListing> = {}): FolderListing => ({
	machine: "jimbo",
	path: "/home/aaron/code",
	home: "/home/aaron",
	parent: "/home/aaron",
	folders: ["acme", "beta"],
	truncated: false,
	...overrides,
});

describe("parseListing", () => {
	it("accepts a well-formed listing and refuses junk", () => {
		assert.deepEqual(parseListing(listing()), listing());
		assert.deepEqual(
			parseListing(listing({ parent: null, path: "/" })),
			listing({ parent: null, path: "/" }),
		);
		assert.equal(parseListing(listing({ folders: ["a/b"] })), null);
		assert.equal(parseListing(listing({ folders: ["bad\nname"] })), null);
		assert.equal(parseListing(listing({ folders: [""] })), null);
		assert.equal(
			parseListing(
				listing({ folders: Array.from({ length: 1001 }, (_, i) => `f${i}`) }),
			),
			null,
		);
		assert.equal(parseListing(listing({ path: "" })), null);
		assert.equal(parseListing({ ...listing(), folders: "acme" }), null);
		assert.equal(parseListing(null), null);
	});
});

describe("hub.browse", () => {
	const v2 = (overrides: Partial<RunnerReport> = {}) =>
		report({ protocol: 2, ...overrides });

	it("refuses an unknown machine", async () => {
		const { hub } = setup();
		assert.deepEqual(await hub.browse("runner_nope", null), {
			ok: false,
			error: "No such machine",
		});
	});

	it("says how to connect an expected runner that never checked in", async () => {
		const { hub } = setup(["spike"]);
		const found = await hub.browse("runner_spike", "/x");
		assert.equal(found.ok, false);
		assert.match(
			found.ok ? "" : found.error,
			/^spike's runner hasn't connected to the board\. On spike, put the board's KANBAN_RUNNER_TOKEN in ~\/\.config\/kanban\/env and start kanban-runner/,
		);
	});

	it("says the token was refused once that runner offered a wrong one", async () => {
		const { hub } = setup(["spike"]);
		hub.refused("spike");
		const found = await hub.browse("runner_spike", null);
		assert.match(
			found.ok ? "" : found.error,
			/^spike's runner offered a token the board refused\. .*KANBAN_RUNNER_TOKEN in ~\/\.config\/kanban\/env on spike/,
		);
	});

	it("adds no machine for a refused name it doesn't expect", () => {
		const { hub } = setup(["spike"]);
		const before = hub.views();
		hub.refused("stranger");
		hub.refused("local");
		assert.deepEqual(hub.views(), before);
	});

	it("says a runner is offline or asleep", async () => {
		const { hub, advance } = setup();
		hub.register(v2());
		advance(20_000);
		hub.sweep();
		assert.deepEqual(await hub.browse("runner_jimbo", null), {
			ok: false,
			error:
				"jimbo's runner is offline, so its folders can't be read. Check that jimbo is on and kanban-runner is running there.",
		});
		// Back with the same boot time: it slept, so next silence reads asleep.
		hub.heartbeat("jimbo", v2());
		advance(20_000);
		hub.sweep();
		assert.deepEqual(await hub.browse("runner_jimbo", null), {
			ok: false,
			error:
				"jimbo is asleep, so its folders can't be read. Wake it and try again.",
		});
	});

	it("asks a runner too old to browse to be restarted", async () => {
		const { hub } = setup();
		hub.register(report({ protocol: 1 }));
		const found = await hub.browse("runner_jimbo", null);
		assert.match(
			found.ok ? "" : found.error,
			/^jimbo's runner is too old to browse folders\. Restart kanban-runner on jimbo/,
		);
		assert.equal((await hub.poll("jimbo", 0))?.length, 0, "nothing sent");
	});

	it("never hands a browse to an old runner that took over the name", async () => {
		const { hub } = setup();
		hub.register(v2());
		const browsed = hub.browse("runner_jimbo", null);
		hub.register(report({ protocol: 1 }));
		assert.deepEqual(await hub.poll("jimbo", 0), [], "nothing sent");
		const found = await browsed;
		assert.match(
			found.ok ? "" : found.error,
			/^jimbo's runner is too old to browse folders/,
		);
	});

	it("lists a folder through the runner's poll", async () => {
		const { hub, changes } = setup();
		hub.register(v2());
		const before = changes();
		const polled = hub.poll("jimbo", 1_000);
		const browsed = hub.browse("runner_jimbo", "~/code");
		const [command] = (await polled) ?? [];
		assert.deepEqual(command, {
			type: "browse",
			commandId: "id-1",
			path: "~/code",
			hubHome: "/Users/aaron",
		});
		assert.equal(
			hub.complete("jimbo", "id-1", { ok: true, listing: listing() }),
			true,
		);
		assert.deepEqual(await browsed, { ok: true, listing: listing() });
		assert.equal(hub.sessions().length, 0, "browsing places no session");
		assert.equal(changes(), before, "nor changes the board");
	});

	it("passes on the runner's own refusal", async () => {
		const { hub } = setup();
		hub.register(v2());
		const browsed = hub.browse("runner_jimbo", "/nope");
		const [command] = (await hub.poll("jimbo", 10)) ?? [];
		hub.complete("jimbo", command?.commandId ?? "", {
			ok: false,
			error: "/nope isn't a folder on jimbo",
		});
		assert.deepEqual(await browsed, {
			ok: false,
			error: "/nope isn't a folder on jimbo",
		});
	});

	it("refuses a malformed or missing listing", async () => {
		const { hub } = setup();
		hub.register(v2());
		const answers: unknown[] = [
			{ ok: true, listing: listing({ folders: ["../etc"] }) },
			{
				ok: true,
				listing: listing({
					folders: Array.from({ length: 1001 }, (_, i) => `f${i}`),
				}),
			},
			{ ok: true },
		];
		for (const body of answers) {
			const browsed = hub.browse("runner_jimbo", null);
			const [command] = (await hub.poll("jimbo", 10)) ?? [];
			hub.complete("jimbo", command?.commandId ?? "", body);
			assert.deepEqual(await browsed, {
				ok: false,
				error: "The runner sent a malformed folder listing",
			});
		}
	});

	it("gives up on a runner that doesn't answer", async () => {
		const { hub } = setup([], { commandTimeoutMs: 60_000 });
		hub.register(v2());
		assert.deepEqual(await hub.browse("runner_jimbo", null), {
			ok: false,
			error: "jimbo didn't answer",
		});
		assert.equal(
			(await hub.poll("jimbo", 0))?.length,
			0,
			"the timed-out command is dropped",
		);
	});
});
