import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunsOn } from "../shared/types.ts";
import {
	type CloudApi,
	type CloudEvent,
	type CloudPty,
	type CloudSessionInfo,
	type CloudSessions,
	cloudBlocker,
	cloudCredentials,
	cloudLauncher,
	cloudTty,
	createCloudApi,
	createCloudSessions,
	parseCloudCreated,
	rejection,
	remoteLauncher,
	runsOnBlocker,
} from "./cloud.ts";
import { keychainService } from "./usage.ts";

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
		assert.deepEqual(
			await api.respond(id, "req-1", { behavior: "allow", updatedInput: {} }),
			{ ok: true, value: null },
		);
		const [send, archive, respond] = calls;
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
		assert.equal(respond?.url, send?.url);
		const [answer] =
			(respond?.body as { events: Record<string, unknown>[] } | undefined)
				?.events ?? [];
		assert.match(String(answer?.uuid), /^[0-9a-f-]{36}$/);
		assert.deepEqual(
			{ ...answer, uuid: "u" },
			{
				uuid: "u",
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "req-1",
					response: { behavior: "allow", updatedInput: {} },
				},
			},
		);
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

	it("lists only the online remote-control hosts", async () => {
		const bridge = (environment_id: string, online: boolean) => ({
			kind: "bridge",
			environment_id,
			name: `pilot:repo:${environment_id}`,
			bridge_info: {
				machine_name: "pilot",
				directory: "/private/tmp/repo",
				online,
			},
		});
		const { fetch, calls } = fakeFetch(() => ({
			body: {
				environments: [
					bridge("env_01live", true),
					bridge("env_01dead", false),
					{
						kind: "anthropic_cloud",
						environment_id: "env_01cloud",
						name: "Default",
						bridge_info: null,
					},
				],
				has_more: false,
			},
		}));
		const api = createCloudApi({ credentials, fetch });
		assert.deepEqual(await api.hosts(), {
			ok: true,
			value: [
				{
					id: "env_01live",
					name: "pilot:repo:env_01live",
					machine: "pilot",
					directory: "/private/tmp/repo",
				},
			],
		});
		assert.equal(
			calls[0]?.url,
			"https://api.anthropic.com/v1/environment_providers",
		);
		assert.equal(calls[0]?.method, "GET");
	});

	it("creates a session on a remote-control host with the first prompt", async () => {
		const { fetch, calls } = fakeFetch(() => ({
			body: { id, session_status: "pending" },
		}));
		const api = createCloudApi({ credentials, fetch });
		assert.deepEqual(
			await api.create("env_01live", "/private/tmp/repo", "Say PONG", "probe"),
			{ ok: true, value: id },
		);
		const [create] = calls;
		assert.equal(
			create?.url,
			"https://api.anthropic.com/v1/sessions?beta=true",
		);
		assert.equal(create?.method, "POST");
		const body = create?.body as {
			events: { data: Record<string, unknown> }[];
		};
		const data = body.events[0]?.data;
		assert.match(String(data?.uuid), /^[0-9a-f-]{36}$/);
		assert.deepEqual(
			{
				...body,
				events: [{ ...body.events[0], data: { ...data, uuid: "u" } }],
			},
			{
				title: "probe",
				environment_id: "env_01live",
				source: "remote-control",
				session_context: {
					sources: [],
					outcomes: [],
					cwd: "/private/tmp/repo",
				},
				events: [
					{
						type: "event",
						data: {
							type: "user",
							uuid: "u",
							session_id: "",
							parent_tool_use_id: null,
							message: { role: "user", content: "Say PONG" },
						},
					},
				],
			},
		);
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
	const setup = async (expiresAt: () => number, clock = { now: 1_000_000 }) => {
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
			now: () => clock.now,
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
		const clock = { now: 1_000_000 };
		const { read, runs } = await setup(
			() => (refreshed ? 2_000_000 : 0),
			clock,
		);
		await assert.rejects(read(), /Cloud sign-in expired/);
		assert.equal(runs[1], "claude auth status");
		refreshed = true;
		await assert.rejects(read(), /Cloud sign-in expired/);
		assert.equal(runs.length, 3);
		clock.now += 60_000;
		assert.equal((await read()).expiresAt, 2_000_000);
	});

	it("shares one keychain read between concurrent callers", async () => {
		const { read, runs } = await setup(() => 2_000_000);
		await Promise.all([read(), read(), read()]);
		assert.equal(runs.length, 1);
	});

	it("rereads the keychain once told the token was refused", async () => {
		const { read, runs } = await setup(() => 2_000_000);
		await read();
		read.forget();
		await read();
		assert.equal(runs.length, 2);
	});

	it("reads a cswap profile's own sign-in and refreshes it there", async () => {
		const profile = await mkdtemp(join(tmpdir(), "kanban-cloud-profile-"));
		await writeFile(
			join(profile, ".claude.json"),
			JSON.stringify({ oauthAccount: { organizationUuid: "profile-org" } }),
		);
		await writeFile(
			join(profile, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: { accessToken: "seeded", expiresAt: 500_000 },
			}),
		);
		let profileClock = 1_000_000;
		const runs: [string, string | undefined][] = [];
		const read = cloudCredentials({
			claudeBin: "claude",
			claudeHome: profile,
			now: () => profileClock,
			run: async (file, args, env) => {
				runs.push([[file, ...args].join(" "), env.CLAUDE_CONFIG_DIR]);
				throw new Error("not in the keychain");
			},
		});
		await assert.rejects(read(), /Cloud sign-in expired/);
		assert.deepEqual(runs, [
			[
				`security find-generic-password -s ${keychainService(profile)} -w`,
				profile,
			],
			["claude auth status", profile],
			[
				`security find-generic-password -s ${keychainService(profile)} -w`,
				profile,
			],
		]);
		await writeFile(
			join(profile, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: { accessToken: "seeded", expiresAt: 2_000_000 },
			}),
		);
		profileClock += 60_000;
		assert.deepEqual(await read(), {
			token: "seeded",
			expiresAt: 2_000_000,
			org: "profile-org",
		});
	});

	it("says to sign in when neither the keychain nor a file has it", async () => {
		const profile = await mkdtemp(join(tmpdir(), "kanban-cloud-profile-"));
		const read = cloudCredentials({
			claudeHome: profile,
			run: async () => {
				throw new Error("not in the keychain");
			},
		});
		await assert.rejects(read(), /need claude signed in to claude.ai/);
	});
});

type FakeCloud = {
	api: CloudApi;
	info: Map<string, CloudSessionInfo>;
	log: Map<string, CloudEvent[]>;
	cursors: (string | null)[];
	archived: string[];
	down: Set<string>;
	responses: [string, string, Record<string, unknown>][];
};

const event = (uuid: string, at: string): CloudEvent => ({
	uuid,
	type: "assistant",
	created_at: at,
	message: { role: "assistant", content: [{ type: "text", text: uuid }] },
});

const prompted = (uuid: string, at: string, text: string): CloudEvent => ({
	uuid,
	type: "user",
	created_at: at,
	message: { role: "user", content: text },
});

const fakeCloud = (): FakeCloud => {
	const fake: FakeCloud = {
		info: new Map(),
		log: new Map(),
		cursors: [],
		archived: [],
		down: new Set(),
		responses: [],
		api: {
			get: async (sessionId) => {
				if (fake.down.has(sessionId)) {
					return { ok: false, error: "Cloud API GET failed with HTTP 500" };
				}
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
			hosts: async () => ({ ok: true, value: [] }),
			create: async () => ({ ok: false, error: "not a host" }),
			send: async () => ({ ok: true, value: null }),
			respond: async (sessionId, requestId, response) => {
				fake.responses.push([sessionId, requestId, response]);
				return { ok: true, value: null };
			},
			archive: async (sessionId) => {
				if (!fake.info.has(sessionId)) {
					return { ok: false, error: "Cloud API POST failed with HTTP 404" };
				}
				fake.archived.push(sessionId);
				return { ok: true, value: null };
			},
		},
	};
	return fake;
};

const asked = (
	uuid: string,
	requestId: string,
	toolName: string,
	input: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): CloudEvent => ({
	uuid,
	type: "control_request",
	created_at: "2026-10-30T12:00:00Z",
	request_id: requestId,
	request: {
		subtype: "can_use_tool",
		tool_name: toolName,
		tool_use_id: `toolu_${requestId}`,
		input,
		...extra,
	},
});

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
		apiFor: () => fake.api,
		pollMs: 5,
		onChange: () => {
			changes += 1;
		},
	});
	return { store, changes: () => changes };
};

const mirrored = async (store: CloudSessions) =>
	(await readFile(store.transcriptPath(id) ?? "", "utf8").catch(() => ""))
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

	it("shows the open permission prompt and answers it through the api", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		const suggestion = {
			type: "addRules",
			behavior: "allow",
			destination: "localSettings",
			rules: [{ toolName: "mcp__remote__add_repo" }],
		};
		fake.info.set(id, info("requires_action", "2026-10-30T12:00:00Z"));
		fake.log.set(id, [
			asked("e1", "old", "Bash", { command: "ls" }),
			{
				uuid: "e2",
				type: "control_cancel_request",
				created_at: "2026-10-30T12:00:00Z",
				request_id: "old",
			},
			asked(
				"e3",
				"repo",
				"mcp__remote__add_repo",
				{ owner: "acme", repo: "api" },
				{ display_name: "Add Repo", permission_suggestions: [suggestion] },
			),
		]);
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(() => store.pending(id) !== null);
		assert.deepEqual(store.pending(id), {
			requestId: "repo",
			toolUseId: "toolu_repo",
			toolName: "mcp__remote__add_repo",
			title: "Add Repo",
			input: { owner: "acme", repo: "api" },
			options: ["Yes", "Yes, and don't ask again", "No"],
		});
		assert.equal((await store.choose(id, "repo", "Maybe")).ok, false);
		assert.deepEqual(
			await store.choose(id, "repo", "Yes, and don't ask again"),
			{
				ok: true,
				value: null,
			},
		);
		assert.deepEqual(fake.responses, [
			[
				id,
				"repo",
				{
					behavior: "allow",
					updatedInput: { owner: "acme", repo: "api" },
					updatedPermissions: [suggestion],
					tool_name: "mcp__remote__add_repo",
				},
			],
		]);
		assert.equal(store.pending(id), null);
		assert.equal((await store.choose(id, "repo", "Yes")).ok, false);
		store.stop();
	});

	it("denies, answers questions, and hides prompts while the session is not waiting", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		const questions = [{ question: "Which?", options: [{ label: "A" }] }];
		fake.info.set(id, info("running", "2026-10-30T12:00:00Z"));
		fake.log.set(id, [
			asked(
				"e1",
				"bash",
				"Bash",
				{ command: "rm -rf build" },
				{
					permission_suggestions: [{ type: "addRules" }],
					server_policy_ask_only: true,
				},
			),
			asked("e2", "ask", "AskUserQuestion", { questions }),
		]);
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(() => fake.cursors.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(store.pending(id), null);
		fake.info.set(id, info("requires_action", "2026-10-30T12:00:01Z"));
		await until(() => store.pending(id) !== null);
		assert.equal(store.pending(id)?.requestId, "ask");
		await store.answer(id, "ask", { "Which?": "A" });
		assert.deepEqual(store.pending(id)?.options, ["Yes", "No"]);
		await store.choose(id, "bash", "No");
		assert.deepEqual(fake.responses, [
			[
				id,
				"ask",
				{
					behavior: "allow",
					updatedInput: { questions, answers: { "Which?": "A" } },
					tool_name: "AskUserQuestion",
				},
			],
			[id, "bash", { behavior: "deny", message: rejection, interrupt: true }],
		]);
		assert.equal(store.pending(id), null);
		store.stop();
	});

	it("drops a prompt answered elsewhere, even when the answer is listed first", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("requires_action", "2026-10-30T12:00:00Z"));
		fake.log.set(id, [
			{
				uuid: "e1",
				type: "control_response",
				created_at: "2026-10-30T12:00:00Z",
				response: { subtype: "success", request_id: "late" },
			},
			asked("e2", "late", "Bash", { command: "ls" }),
			asked("e3", "open", "Bash", { command: "pwd" }),
		]);
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(() => store.pending(id) !== null);
		assert.equal(store.pending(id)?.requestId, "open");
		fake.log.get(id)?.push({
			uuid: "e4",
			type: "control_response",
			created_at: "2026-10-30T12:00:01Z",
			response: { subtype: "success", request_id: "open" },
		});
		fake.info.set(id, info("requires_action", "2026-10-30T12:00:01Z"));
		await until(() => store.pending(id) === null);
		store.stop();
	});

	it("rereads events while the session waits on a prompt it has not listed yet", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("requires_action", "2026-10-30T12:00:00Z"));
		fake.log.set(id, [event("e1", "2026-10-30T12:00:00Z")]);
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(() => fake.cursors.length > 0);
		fake.log.get(id)?.push(asked("e2", "late", "Bash", { command: "ls" }));
		await until(() => store.pending(id) !== null);
		const fetches = fake.cursors.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(fake.cursors.length, fetches, "stops once it has the prompt");
		store.stop();
	});

	it("answers a prompt once, keeps it open when the answer fails, and shows the session working", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("requires_action", "2026-10-30T12:00:00Z"));
		fake.log.set(id, [asked("e1", "only", "Bash", { command: "ls" })]);
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(() => store.pending(id) !== null);
		const respond = fake.api.respond;
		fake.api.respond = async () => ({ ok: false, error: "HTTP 500" });
		assert.deepEqual(await store.choose(id, "only", "Yes"), {
			ok: false,
			error: "HTTP 500",
		});
		assert.equal(store.pending(id)?.requestId, "only");
		fake.api.respond = respond;
		fake.down.add(id);
		const [first, second] = await Promise.all([
			store.choose(id, "only", "Yes"),
			store.choose(id, "only", "No"),
		]);
		assert.equal(first.ok, true);
		assert.equal(second.ok, false);
		assert.equal(fake.responses.length, 1);
		assert.equal(store.pending(id), null);
		assert.equal(store.sessions()[0]?.activity, "working");
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
		assert.deepEqual(fake.cursors, [null, null]);
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

	it("mirrors an event the api lists late, behind ones already mirrored", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("idle", "2026-10-30T12:00:00Z"));
		fake.log.set(id, [event("e1", "2026-10-30T12:00:00Z")]);
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(async () => (await mirrored(store)).length === 1);
		fake.log.get(id)?.push(event("e3", "2026-10-30T12:00:02Z"));
		fake.info.set(id, info("running", "2026-10-30T12:00:02Z"));
		await until(async () => (await mirrored(store)).length === 2);
		fake.log
			.get(id)
			?.splice(1, 0, prompted("u2", "2026-10-30T12:00:01Z", "Wake up"));
		fake.log.get(id)?.push(event("e4", "2026-10-30T12:00:03Z"));
		fake.info.set(id, info("idle", "2026-10-30T12:00:03Z"));
		await until(async () => (await mirrored(store)).length === 4);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(
			(await mirrored(store)).map((line) => line.uuid),
			["e1", "e3", "u2", "e4"],
		);
		store.stop();
	});

	it("rereads only the last fifty mirrored events", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		const at = (second: number) =>
			new Date(Date.UTC(2026, 9, 30, 12, 0, second)).toISOString();
		fake.info.set(id, info("idle", at(0)));
		fake.log.set(
			id,
			Array.from({ length: 55 }, (_, n) => event(`e${n}`, at(n))),
		);
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(async () => (await mirrored(store)).length === 55);
		fake.log.get(id)?.splice(20, 0, prompted("late", at(20), "Wake up"));
		fake.log.get(id)?.push(event("e55", at(55)));
		fake.info.set(id, info("idle", at(55)));
		await until(async () => (await mirrored(store)).length === 57);
		assert.deepEqual(fake.cursors, [null, "e4"]);
		assert.deepEqual(
			(await mirrored(store)).slice(-2).map((line) => line.uuid),
			["late", "e55"],
		);
		store.stop();
	});

	it("shows a sent prompt at once and only once when the api lists it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("idle", "2026-10-30T12:00:00Z"));
		fake.log.set(id, [event("e1", "2026-10-30T12:00:00Z")]);
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(async () => (await mirrored(store)).length === 1);
		assert.deepEqual(await store.send(id, "Carry on"), {
			ok: true,
			value: null,
		});
		const prompts = async () =>
			(await mirrored(store)).flatMap((line) =>
				line.type === "user"
					? [(line as { message?: { content?: unknown } }).message?.content]
					: [],
			);
		assert.deepEqual(await prompts(), ["Carry on"]);
		fake.log
			.get(id)
			?.push(
				prompted("u2", "2026-10-30T12:00:01Z", "Carry on"),
				event("e3", "2026-10-30T12:00:02Z"),
			);
		fake.info.set(id, info("idle", "2026-10-30T12:00:02Z"));
		await until(async () => (await mirrored(store)).length === 3);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(await prompts(), ["Carry on"]);
		store.stop();
	});

	it("leaves a failed send out of the mirror", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("idle", "2026-10-30T12:00:00Z"));
		fake.api.send = async () => ({ ok: false, error: "HTTP 500" });
		const { store } = await storeIn(dir, fake);
		store.add(record);
		assert.deepEqual(await store.send(id, "Carry on"), {
			ok: false,
			error: "HTTP 500",
		});
		fake.log.set(id, [prompted("u1", "2026-10-30T12:00:01Z", "Carry on")]);
		fake.info.set(id, info("idle", "2026-10-30T12:00:01Z"));
		await until(async () => (await mirrored(store)).length === 1);
		assert.equal((await mirrored(store))[0]?.uuid, "u1");
		store.stop();
	});

	it("opens the mirror with the first prompt and drops the api's copy of it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("idle", "2026-10-30T12:00:01Z"));
		fake.log.set(id, [
			prompted("u0", "2026-10-30T12:00:00.5Z", "Probe it"),
			event("e1", "2026-10-30T12:00:01Z"),
		]);
		const opened = {
			...record,
			createdAt: Date.parse("2026-10-30T12:00:00Z"),
			prompt: "Probe it",
		};
		const first = await storeIn(dir, fake);
		first.store.add(opened);
		const expected = [
			["user", "Probe it", "2026-10-30T12:00:00.000Z"],
			["assistant", [{ type: "text", text: "e1" }], "2026-10-30T12:00:01Z"],
		];
		const shape = async (store: CloudSessions) =>
			(await mirrored(store)).map((line) => [
				line.type,
				(line as { message?: { content?: unknown } }).message?.content,
				line.timestamp,
			]);
		await until(async () => (await mirrored(first.store)).length === 2);
		assert.deepEqual(await shape(first.store), expected);
		first.store.stop();

		const second = await storeIn(dir, fake);
		await until(async () => (await mirrored(second.store)).length === 2);
		assert.deepEqual(await shape(second.store), expected);
		second.store.stop();
	});

	it("talks to each session through its own account", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const mine = fakeCloud();
		const theirs = fakeCloud();
		const other = "session_01Other";
		mine.info.set(id, info("idle", "2026-10-30T12:00:00Z"));
		theirs.info.set(other, {
			...info("idle", "2026-10-30T12:00:00Z"),
			id: other,
		});
		const asked: (string | undefined)[] = [];
		const store = await createCloudSessions({
			file: join(dir, "cloud.json"),
			dir: join(dir, "cloud"),
			apiFor: (configDir) => {
				asked.push(configDir);
				return configDir === "/profiles/2" ? theirs.api : mine.api;
			},
			pollMs: 5,
			onChange: () => {},
		});
		store.add(record);
		store.add({ ...record, id: other, configDir: "/profiles/2" });
		await until(() =>
			store.sessions().every((session) => session.name === "Probe the cloud"),
		);
		assert.deepEqual(
			store.sessions().map((session) => [session.id, session.configDir]),
			[
				[id, undefined],
				[other, "/profiles/2"],
			],
		);
		assert.ok(asked.includes(undefined) && asked.includes("/profiles/2"));
		await until(async () =>
			(
				await readFile(join(dir, "cloud.json"), "utf8").catch(() => "")
			).includes("/profiles/2"),
		);
		assert.deepEqual(await store.archive(other), { ok: true, value: null });
		assert.deepEqual(theirs.archived, [other]);
		assert.deepEqual(mine.archived, []);
		assert.equal((await store.archive("session_01Gone")).ok, false);
		await until(async () => {
			const saved = JSON.parse(await readFile(join(dir, "cloud.json"), "utf8"));
			return saved.length === 1 && saved[0].id === id;
		});
		store.stop();
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
			fake.down.add(id);
			await until(() => logged.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 40));
		} finally {
			console.error = original;
		}
		assert.equal(logged.length, 1);
		assert.match(logged[0] ?? "", /HTTP 500/);
		assert.equal(store.sessions()[0]?.activity, "working");
		store.stop();
	});

	it("drops a session claude.ai no longer has, by poll or by exit", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.info.set(id, info("running", "2026-10-30T12:00:00Z"));
		const { store } = await storeIn(dir, fake);
		store.add(record);
		await until(() => store.sessions()[0]?.name === "Probe the cloud");
		fake.info.delete(id);
		await until(() => store.sessions().length === 0);
		store.add(record);
		assert.deepEqual(await store.archive(id), { ok: true, value: null });
		assert.deepEqual(store.sessions(), []);
		store.stop();
	});

	it("logs a poll that throws instead of crashing the board", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-"));
		const fake = fakeCloud();
		fake.api.get = async () => {
			throw new TypeError("unexpected body");
		};
		const { store } = await storeIn(dir, fake);
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args.join(" "));
		try {
			store.add(record);
			await until(() => logged.length > 0);
		} finally {
			console.error = original;
		}
		assert.match(logged[0] ?? "", /unexpected body/);
		store.stop();
	});
});

type FakePty = CloudPty & {
	emit(data: string): void;
	exit(code: number): void;
	killed: string[];
	spawned: { file: string; args: string[]; cwd: string };
	env: NodeJS.ProcessEnv;
};

const fakePtySpawn = () => {
	const ptys: FakePty[] = [];
	return {
		ptys,
		spawn: (
			file: string,
			args: string[],
			options: { cwd: string; env: NodeJS.ProcessEnv },
		): CloudPty => {
			let onData: (data: string) => void = () => {};
			let onExit: (event: { exitCode: number }) => void = () => {};
			const terminal: FakePty = {
				spawned: { file, args, cwd: options.cwd },
				env: options.env,
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
	const ready = async () => null;

	const started = async (ptys: FakePty[]) => {
		await until(() => ptys.length > 0);
		return ptys[0] as FakePty;
	};

	it("returns the new session's id and lets go of the terminal", async () => {
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher({
			claudeBin: "claude",
			blocker: ready,
			spawnPty: spawn,
		})(request);
		const terminal = await started(ptys);
		assert.deepEqual(terminal.spawned, {
			file: "claude",
			args: ["--cloud=Fix it", "--name", "fix"],
			cwd: request.cwd,
		});
		terminal.emit(created.slice(0, 60));
		terminal.emit(created.slice(60));
		assert.deepEqual(await launching, { ok: true, id });
		assert.deepEqual(terminal.killed, ["SIGHUP"]);
	});

	it("reports the last line when claude exits without a session", async () => {
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher({
			claudeBin: "claude",
			blocker: ready,
			spawnPty: spawn,
		})({
			cwd: request.cwd,
			prompt: "Fix it",
		});
		const terminal = await started(ptys);
		assert.deepEqual(terminal.spawned.args, ["--cloud=Fix it"]);
		terminal.emit("Error: Cloud sessions are not available.\r\n");
		terminal.exit(1);
		assert.deepEqual(await launching, {
			ok: false,
			error: "claude --cloud failed: Error: Cloud sessions are not available.",
		});
		assert.deepEqual(terminal.killed, []);
	});

	it("gives up on a launch that never answers", async () => {
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher({
			claudeBin: "claude",
			blocker: ready,
			spawnPty: spawn,
			timeoutMs: 10,
		})(request);
		const terminal = await started(ptys);
		terminal.emit("Connecting…");
		assert.deepEqual(await launching, {
			ok: false,
			error: "claude --cloud failed: Connecting…",
		});
		assert.deepEqual(terminal.killed, ["SIGHUP"]);
	});

	it("refuses a folder the cloud can't start from without launching", async () => {
		const { ptys, spawn } = fakePtySpawn();
		const blocked: string[] = [];
		const launching = cloudLauncher({
			claudeBin: "claude",
			blocker: async (cwd) => {
				blocked.push(cwd);
				return "This folder isn't a git repository";
			},
			spawnPty: spawn,
		})(request);
		assert.deepEqual(await launching, {
			ok: false,
			error: "This folder isn't a git repository",
		});
		assert.deepEqual(blocked, [request.cwd]);
		assert.equal(ptys.length, 0);
	});

	it("runs on the chosen account and remembers its profile", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-account-"));
		const profile = join(dir, "profile");
		const defaultConfig = join(dir, "claude.json");
		await mkdir(profile);
		await writeFile(
			defaultConfig,
			JSON.stringify({
				projects: { [request.cwd]: { hasTrustDialogAccepted: true } },
			}),
		);
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher({
			claudeBin: "/opt/claude/bin/claude",
			cswapBin: "cswap",
			defaultConfig,
			profileOf: (account) => (account === 2 ? profile : null),
			blocker: ready,
			spawnPty: spawn,
		})({ ...request, account: 2 });
		const terminal = await started(ptys);
		assert.deepEqual(terminal.spawned, {
			file: "cswap",
			args: [
				"run",
				"2",
				"--share-history",
				"--",
				"--cloud=Fix it",
				"--name",
				"fix",
			],
			cwd: request.cwd,
		});
		assert.match(terminal.env.PATH ?? "", /^\/opt\/claude\/bin/);
		terminal.emit(created);
		assert.deepEqual(await launching, { ok: true, id, configDir: profile });
	});

	it("trusts the folder in a profile at its trust prompt, then launches again", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-account-"));
		const profile = join(dir, "profile");
		const defaultConfig = join(dir, "claude.json");
		await writeFile(
			defaultConfig,
			JSON.stringify({
				projects: { [request.cwd]: { hasTrustDialogAccepted: true } },
			}),
		);
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher({
			claudeBin: "claude",
			defaultConfig,
			profileOf: () => profile,
			blocker: ready,
			spawnPty: spawn,
		})({ ...request, account: 2 });
		const first = await started(ptys);
		await mkdir(profile);
		first.emit("Yes, I trust this folder");
		await until(() => ptys.length === 2);
		const trusted = JSON.parse(
			await readFile(join(profile, ".claude.json"), "utf8"),
		);
		assert.equal(trusted.projects[request.cwd].hasTrustDialogAccepted, true);
		ptys[1]?.emit(created);
		assert.deepEqual(await launching, { ok: true, id, configDir: profile });
		assert.deepEqual(first.killed, ["SIGHUP"]);
	});

	it("stops at a trust prompt and says how to accept it", async () => {
		const { ptys, spawn } = fakePtySpawn();
		const launching = cloudLauncher({
			claudeBin: "claude",
			blocker: ready,
			spawnPty: spawn,
		})({ ...request, account: 3 });
		const terminal = await started(ptys);
		terminal.emit(
			`Quick safety check${esc}[1C❯ No, exit\r\n  Yes,${esc}[1CI${esc}[1Ctrust${esc}[1Cthis${esc}[1Cfolder`,
		);
		const result = await launching;
		assert.equal(result.ok, false);
		assert.match(
			!result.ok ? result.error : "",
			/Workspace not trusted: run cswap run 3 in \/Users\/me\/dev\/acme-api/,
		);
		assert.deepEqual(terminal.killed, ["SIGHUP"]);
	});
});

const git = (cwd: string, ...args: string[]) =>
	new Promise<void>((resolve, reject) =>
		execFile(
			"git",
			[
				"-C",
				cwd,
				"-c",
				"user.email=kanban@example.com",
				"-c",
				"user.name=kanban",
				...args,
			],
			(error) => (error ? reject(error) : resolve()),
		),
	);

describe("cloudBlocker", () => {
	it("lets a repository with a commit through", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-cloud-repo-"));
		await git(dir, "init", "-q");
		await writeFile(join(dir, "a.txt"), "a");
		await git(dir, "add", "a.txt");
		await git(dir, "commit", "-qm", "init");
		assert.equal(await cloudBlocker(dir), null);
		await mkdir(join(dir, "sub"));
		assert.equal(await cloudBlocker(join(dir, "sub")), null);
	});

	it("names why a folder can't seed a cloud session", async () => {
		const plain = await mkdtemp(join(tmpdir(), "kanban-cloud-plain-"));
		assert.match((await cloudBlocker(plain)) ?? "", /Not a git repository/);
		const empty = await mkdtemp(join(tmpdir(), "kanban-cloud-empty-"));
		await git(empty, "init", "-q");
		assert.match((await cloudBlocker(empty)) ?? "", /Needs a first commit/);
		assert.match((await cloudBlocker("relative")) ?? "", /absolute path/);
	});
});

describe("remoteLauncher", () => {
	const hostApi = (directory: string) => {
		const created: unknown[][] = [];
		const configs: (string | undefined)[] = [];
		const api: CloudApi = {
			...fakeCloud().api,
			hosts: async () => ({
				ok: true,
				value: [
					{ id: "env_01live", name: "probe", machine: "pilot", directory },
				],
			}),
			create: async (...args) => {
				created.push(args);
				return { ok: true, value: id };
			},
		};
		const apiFor = (configDir?: string) => {
			configs.push(configDir);
			return api;
		};
		return { apiFor, created, configs };
	};

	const repoWithWorktree = async () => {
		const root = await mkdtemp(join(tmpdir(), "kanban-remote-"));
		const main = join(root, "main");
		await mkdir(main);
		await git(main, "init", "-q");
		await writeFile(join(main, "a.txt"), "a");
		await git(main, "add", "a.txt");
		await git(main, "commit", "-qm", "init");
		await git(main, "worktree", "add", "-q", join(root, "tree"));
		return { main, tree: join(root, "tree"), root };
	};

	const request = (cwd: string, runsOn: RunsOn = "env_01live") => ({
		cwd,
		prompt: "Say PONG",
		name: "probe",
		runsOn,
	});

	it("starts the session on the host serving the folder or its main checkout", async () => {
		const { main, tree } = await repoWithWorktree();
		const fake = hostApi(main);
		const launch = remoteLauncher({
			apiFor: fake.apiFor,
			profileOf: (account) => `/profiles/${account}`,
		});
		assert.deepEqual(await launch(request(main)), { ok: true, id });
		assert.deepEqual(await launch({ ...request(tree), account: 2 }), {
			ok: true,
			id,
			configDir: "/profiles/2",
		});
		assert.deepEqual(fake.configs, [undefined, "/profiles/2"]);
		assert.deepEqual(fake.created, [
			["env_01live", main, "Say PONG", "probe"],
			["env_01live", main, "Say PONG", "probe"],
		]);
	});

	it("refuses a host that is gone or serves another folder", async () => {
		const { main } = await repoWithWorktree();
		const other = await mkdtemp(join(tmpdir(), "kanban-remote-other-"));
		const fake = hostApi(other);
		const launch = remoteLauncher({ apiFor: fake.apiFor });
		assert.deepEqual(await launch(request(main, "env_01gone")), {
			ok: false,
			error: "That remote-control host is no longer running",
		});
		assert.deepEqual(await launch(request(main)), {
			ok: false,
			error: `pilot serves ${other}, not this folder`,
		});
		assert.deepEqual(fake.created, []);
	});

	it("blocks up front with the same reasons and leaves This Mac alone", async () => {
		const { main } = await repoWithWorktree();
		const fake = hostApi("/elsewhere");
		const blocked = runsOnBlocker(
			() => fake.apiFor(),
			async () => "no commits",
		);
		assert.equal(
			await blocked(main, "env_01live"),
			"pilot serves /elsewhere, not this folder",
		);
		assert.equal(await blocked(main, "cloud"), "no commits");
		assert.equal(await blocked(main, "local"), null);
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
				pending: () => null,
				choose: async () => ({ ok: true, value: null }),
				answer: async () => ({ ok: true, value: null }),
			},
			id,
		);
		assert.deepEqual(await tty.send("hello"), { ok: true, value: null });
		assert.deepEqual(sent, [[id, "hello"]]);
		assert.deepEqual(await tty.screen(), { ok: true, value: "" });
		const refused = await tty.keys(["Escape"]);
		assert.equal(refused.ok, false);
		assert.match(!refused.ok ? refused.error : "", /on claude\.ai/);
		assert.equal((await tty.paste("x")).ok, false);
		assert.equal(tty.isOpen(), true);
	});
});
