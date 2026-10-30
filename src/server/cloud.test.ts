import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type CloudApi,
	type CloudEvent,
	type CloudPty,
	type CloudSessionInfo,
	type CloudSessions,
	cloudCredentials,
	cloudLauncher,
	cloudTty,
	createCloudApi,
	createCloudSessions,
	parseCloudCreated,
} from "./cloud.ts";

const id = "session_01Thu3Jg2qaDGVcVCQbuTiuP";
const esc = String.fromCharCode(27);

const created = [
	`${esc}[1mCreated cloud session:${esc}[22m kanban-probe`,
	`View: ${esc}[4mhttps://claude.ai/code/${id}?from=cli&m=0${esc}[24m`,
	`Resume with: claude --teleport ${id}`,
	"",
].join("\r\n");

const until = async (check: () => boolean | Promise<boolean>, ms = 2000) => {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

describe("parseCloudCreated", () => {
	it("reads the session id from claude --cloud output", () => {
		assert.equal(parseCloudCreated(created), id);
	});

	it("waits for the whole id and ignores errors", () => {
		assert.equal(
			parseCloudCreated(
				`Created cloud session: x\r\nView: https://claude.ai/code/session_01Th`,
			),
			null,
		);
		assert.equal(
			parseCloudCreated(
				"Error: Attaching to an existing cloud session is not enabled for your account.\r\n",
			),
			null,
		);
	});
});

const credentials = async () => ({
	token: "secret-token",
	expiresAt: Date.now() + 3_600_000,
	org: "org-uuid",
});

type Call = { url: string; method: string; headers: Headers; body: unknown };

const fakeFetch = (
	reply: (url: URL) => { status?: number; body: unknown },
): { fetch: typeof fetch; calls: Call[] } => {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			const url = new URL(String(input));
			calls.push({
				url: String(input),
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			const { status = 200, body } = reply(url);
			return new Response(JSON.stringify(body), { status });
		},
	};
};

describe("createCloudApi", () => {
	it("signs every request for the sessions api", async () => {
		const { fetch, calls } = fakeFetch(() => ({ body: {} }));
		const api = createCloudApi({ credentials, fetch });
		assert.deepEqual(await api.send(id, "Run the tests"), {
			ok: true,
			value: null,
		});
		assert.deepEqual(await api.archive(id), { ok: true, value: null });
		const [send, archive] = calls;
		assert.equal(
			send?.url,
			`https://api.anthropic.com/v1/sessions/${id}/events?beta=true`,
		);
		assert.equal(send?.method, "POST");
		assert.equal(send?.headers.get("authorization"), "Bearer secret-token");
		assert.equal(send?.headers.get("x-organization-uuid"), "org-uuid");
		assert.equal(send?.headers.get("anthropic-version"), "2023-06-01");
		assert.equal(send?.headers.get("anthropic-beta"), "ccr-byoc-2025-07-29");
		assert.equal(send?.headers.get("content-type"), "application/json");
		const [event] =
			(send?.body as { events: Record<string, unknown>[] } | undefined)
				?.events ?? [];
		assert.match(String(event?.uuid), /^[0-9a-f-]{36}$/);
		assert.deepEqual(
			{ ...event, uuid: "u" },
			{
				type: "user",
				uuid: "u",
				session_id: id,
				parent_tool_use_id: null,
				message: { role: "user", content: "Run the tests" },
			},
		);
		assert.equal(
			archive?.url,
			`https://api.anthropic.com/v1/sessions/${id}/archive?beta=true`,
		);
		assert.equal(archive?.method, "POST");
		assert.deepEqual(archive?.body, {});
	});

	it("pages through events and names the status of a failure", async () => {
		const pages: Record<string, { data: object[]; has_more: boolean }> = {
			"": { data: [{ uuid: "e1" }, { uuid: "e2" }], has_more: true },
			e2: { data: [{ uuid: "e3" }], has_more: false },
		};
		const { fetch, calls } = fakeFetch((url) => {
			if (url.pathname.endsWith("/missing")) return { status: 404, body: {} };
			return { body: pages[url.searchParams.get("after_id") ?? ""] };
		});
		const api = createCloudApi({ credentials, fetch });
		const events = await api.events(id, null);
		assert.deepEqual(events.ok && events.value.map((event) => event.uuid), [
			"e1",
			"e2",
			"e3",
		]);
		assert.deepEqual(
			calls.map((call) => new URL(call.url).search),
			["?beta=true&limit=100", "?beta=true&limit=100&after_id=e2"],
		);
		const missing = await api.get("missing");
		assert.equal(missing.ok, false);
		assert.match(!missing.ok ? missing.error : "", /HTTP 404/);
	});

	it("reports a sign-in problem without the token", async () => {
		const api = createCloudApi({
			credentials: async () => {
				throw new Error("Cloud sign-in expired: run claude once to refresh it");
			},
			fetch: async () => assert.fail("fetched without credentials"),
		});
		assert.deepEqual(await api.get(id), {
			ok: false,
			error:
				"Cloud API unreachable: Cloud sign-in expired: run claude once to refresh it",
		});
	});
});

describe("cloudCredentials", () => {
	const setup = async (expiresAt: () => number) => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-creds-"));
		const configFile = join(dir, "claude.json");
		await writeFile(
			configFile,
			JSON.stringify({ oauthAccount: { organizationUuid: "org-uuid" } }),
		);
		const runs: string[] = [];
		const read = cloudCredentials({
			claudeBin: "claude",
			configFile,
			now: () => 1_000_000,
			run: async (file, args) => {
				runs.push([file, ...args].join(" "));
				return JSON.stringify({
					claudeAiOauth: { accessToken: "token", expiresAt: expiresAt() },
				});
			},
		});
		return { read, runs };
	};

	it("reads the keychain once while the token is fresh", async () => {
		const { read, runs } = await setup(() => 2_000_000);
		assert.deepEqual(await read(), {
			token: "token",
			expiresAt: 2_000_000,
			org: "org-uuid",
		});
		await read();
		assert.deepEqual(runs, [
			"security find-generic-password -s Claude Code-credentials -w",
		]);
	});

	it("asks claude to refresh an expired token, then gives up", async () => {
		let refreshed = false;
		const { read, runs } = await setup(() => (refreshed ? 2_000_000 : 0));
		await assert.rejects(read(), /Cloud sign-in expired/);
		assert.equal(runs[1], "claude auth status");
		refreshed = true;
		assert.equal((await read()).expiresAt, 2_000_000);
	});
});

type FakeCloud = {
	api: CloudApi;
	info: Map<string, CloudSessionInfo>;
	log: Map<string, CloudEvent[]>;
	cursors: (string | null)[];
	archived: string[];
};

const event = (uuid: string, at: string): CloudEvent => ({
	uuid,
	type: "assistant",
	created_at: at,
	message: { role: "assistant", content: [{ type: "text", text: uuid }] },
});

const fakeCloud = (): FakeCloud => {
	const fake: FakeCloud = {
		info: new Map(),
		log: new Map(),
		cursors: [],
		archived: [],
		api: {
			get: async (sessionId) => {
				const info = fake.info.get(sessionId);
				return info
					? { ok: true, value: info }
					: { ok: false, error: "Cloud API GET failed with HTTP 404" };
			},
			events: async (sessionId, afterId) => {
				fake.cursors.push(afterId);
				const events = fake.log.get(sessionId) ?? [];
				const from = afterId
					? events.findIndex((item) => item.uuid === afterId) + 1
					: 0;
				return { ok: true, value: events.slice(from) };
			},
			send: async () => ({ ok: true, value: null }),
			archive: async (sessionId) => {
				fake.archived.push(sessionId);
				return { ok: true, value: null };
			},
		},
	};
	return fake;
};

const info = (
	status: string,
	updatedAt: string,
	summary: CloudSessionInfo["external_metadata"] = {},
): CloudSessionInfo => ({
	id,
	title: "Probe the cloud",
	session_status: status,
	updated_at: updatedAt,
	external_metadata: summary,
});

const record = {
	id,
	cwd: "/Users/me/dev/acme-api",
	name: "acme-api",
	createdAt: 1,
};

const storeIn = async (dir: string, fake: FakeCloud) => {
	let changes = 0;
	const store = await createCloudSessions({
		file: join(dir, "cloud.json"),
		dir: join(dir, "cloud"),
		api: fake.api,
		pollMs: 5,
		onChange: () => {
			changes += 1;
		},
	});
	return { store, changes: () => changes };
};

const mirrored = async (store: CloudSessions) =>
	(await readFile(store.transcriptPath(id) ?? "", "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as CloudEvent & { timestamp: string });

describe("createCloudSessions", () => {
	it("maps the session's status to card activity", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("running", "2026-10-30T12:00:00Z"));
		const { store } = await storeIn(dir, fake);
		store.add(record);
		const activity = () => store.sessions()[0]?.activity;
		await until(() => store.sessions()[0]?.name === "Probe the cloud");
		assert.equal(activity(), "working");
		assert.equal(store.sessions()[0]?.url, `https://claude.ai/code/${id}`);
		fake.info.set(
			id,
			info("idle", "2026-10-30T12:01:00Z", {
				post_turn_summary: {
					status_category: "blocked",
					status_detail: "Wants to push",
					needs_action: "Approve the push",
				},
			}),
		);
		await until(() => activity() === "needs-you");
		assert.equal(store.sessions()[0]?.detail, "Approve the push");
		fake.info.set(id, info("requires_action", "2026-10-30T12:01:30Z"));
		await until(() => store.sessions()[0]?.detail === null);
		assert.equal(activity(), "needs-you");
		fake.info.set(id, {
			...info("idle", "2026-10-30T12:02:00Z"),
			session_url: "https://claude.ai/code/elsewhere",
		});
		await until(() => activity() === "idle");
		assert.equal(store.sessions()[0]?.detail, null);
		assert.equal(store.sessions()[0]?.url, "https://claude.ai/code/elsewhere");
		store.stop();
	});

	it("forgets an archived session and saves that", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("idle", "2026-10-30T12:00:00Z"));
		const { store, changes } = await storeIn(dir, fake);
		store.add(record);
		await until(async () =>
			(
				await readFile(join(dir, "cloud.json"), "utf8").catch(() => "")
			).includes(id),
		);
		fake.info.set(id, info("archived", "2026-10-30T12:01:00Z"));
		await until(() => store.sessions().length === 0);
		assert.ok(changes() > 0);
		assert.equal(store.transcriptPath(id), null);
		await until(
			async () =>
				(await readFile(join(dir, "cloud.json"), "utf8")).trim() === "[]",
		);
		store.stop();
	});

	it("archives through the api and stops showing the session", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("idle", "2026-10-30T12:00:00Z"));
		const { store } = await storeIn(dir, fake);
		store.add(record);
		assert.deepEqual(await store.archive(id), { ok: true, value: null });
		assert.deepEqual(fake.archived, [id]);
		assert.deepEqual(store.sessions(), []);
		store.stop();
	});

	it("mirrors new events once each, then refetches them all after a restart", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("running", "2026-10-30T12:00:00Z"));
		fake.log.set(id, [
			event("e1", "2026-10-30T12:00:00Z"),
			event("e2", "2026-10-30T12:00:01Z"),
		]);
		const first = await storeIn(dir, fake);
		first.store.add(record);
		await until(async () => (await mirrored(first.store)).length === 2);
		fake.log.get(id)?.push(event("e3", "2026-10-30T12:00:02Z"));
		fake.info.set(id, info("running", "2026-10-30T12:00:02Z"));
		await until(async () => (await mirrored(first.store)).length === 3);
		await new Promise((resolve) => setTimeout(resolve, 30));
		const lines = await mirrored(first.store);
		assert.deepEqual(
			lines.map((line) => [line.uuid, line.timestamp]),
			[
				["e1", "2026-10-30T12:00:00Z"],
				["e2", "2026-10-30T12:00:01Z"],
				["e3", "2026-10-30T12:00:02Z"],
			],
		);
		assert.deepEqual(fake.cursors, [null, "e2"]);
		first.store.stop();

		fake.cursors.length = 0;
		await writeFile(first.store.transcriptPath(id) ?? "", "stale\n");
		const second = await storeIn(dir, fake);
		assert.deepEqual(
			second.store.sessions().map((session) => session.id),
			[id],
		);
		await until(async () => (await mirrored(second.store)).length === 3);
		assert.deepEqual(fake.cursors, [null]);
		second.store.stop();
	});

	it("keeps the last known state and logs a failure once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("running", "2026-10-30T12:00:00Z"));
		const { store } = await storeIn(dir, fake);
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args.join(" "));
		try {
			store.add(record);
			await until(() => store.sessions()[0]?.name === "Probe the cloud");
			fake.info.delete(id);
			await until(() => logged.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 40));
		} finally {
			console.error = original;
		}
		assert.equal(logged.length, 1);
		assert.match(logged[0] ?? "", /HTTP 404/);
		assert.equal(store.sessions()[0]?.activity, "working");
		store.stop();
	});
});

type FakePty = CloudPty & {
	emit(data: string): void;
	exit(code: number): void;
	killed: string[];
	spawned: { file: string; args: string[]; cwd: string };
};

const fakePtySpawn = () => {
	const ptys: FakePty[] = [];
	return {
		ptys,
		spawn: (
			file: string,
			args: string[],
			options: { cwd: string },
		): CloudPty => {
			let onData: (data: string) => void = () => {};
			let onExit: (event: { exitCode: number }) => void = () => {};
			const terminal: FakePty = {
				spawned: { file, args, cwd: options.cwd },
				killed: [],
				onData: (listener) => {
					onData = listener;
				},
				onExit: (listener) => {
					onExit = listener;
				},
				kill: (signal = "SIGHUP") => terminal.killed.push(signal),
				emit: (data) => onData(data),
				exit: (exitCode) => onExit({ exitCode }),
			};
			ptys.push(terminal);
			return terminal;
		},
	};
};

describe("cloudLauncher", () => {
	const request = {
		cwd: "/Users/me/dev/acme-api",
		prompt: "Fix it",
		name: "fix",
	};

	it("returns the new session's id and lets go of the terminal", async () => {
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher("claude", spawn)(request);
		const [terminal] = ptys;
		assert.deepEqual(terminal?.spawned, {
			file: "claude",
			args: ["--cloud=Fix it", "--name", "fix"],
			cwd: request.cwd,
		});
		terminal?.emit(created.slice(0, 60));
		terminal?.emit(created.slice(60));
		assert.deepEqual(await launching, { ok: true, id });
		assert.deepEqual(terminal?.killed, ["SIGHUP"]);
	});

	it("reports the last line when claude exits without a session", async () => {
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher(
			"claude",
			spawn,
		)({
			cwd: request.cwd,
			prompt: "Fix it",
		});
		const [terminal] = ptys;
		assert.deepEqual(terminal?.spawned.args, ["--cloud=Fix it"]);
		terminal?.emit("Error: Cloud sessions are not available.\r\n");
		terminal?.exit(1);
		assert.deepEqual(await launching, {
			ok: false,
			error: "claude --cloud failed: Error: Cloud sessions are not available.",
		});
		assert.deepEqual(terminal?.killed, []);
	});

	it("gives up on a launch that never answers", async () => {
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher("claude", spawn, 10)(request);
		ptys[0]?.emit("Connecting…");
		assert.deepEqual(await launching, {
			ok: false,
			error: "claude --cloud failed: Connecting…",
		});
		assert.deepEqual(ptys[0]?.killed, ["SIGHUP"]);
	});
});

describe("cloudTty", () => {
	it("sends prompts through the store and refuses keys", async () => {
		const sent: [string, string][] = [];
		const tty = cloudTty(
			{
				send: async (sessionId, text) => {
					sent.push([sessionId, text]);
					return { ok: true, value: null };
				},
			},
			id,
		);
		assert.deepEqual(await tty.send("hello"), { ok: true, value: null });
		assert.deepEqual(sent, [[id, "hello"]]);
		assert.deepEqual(await tty.screen(), { ok: true, value: "" });
		const refused = await tty.keys(["Escape"]);
		assert.equal(refused.ok, false);
		assert.match(!refused.ok ? refused.error : "", /terminal view/);
		assert.equal((await tty.paste("x")).ok, false);
		assert.equal(tty.isOpen(), true);
	});
});
