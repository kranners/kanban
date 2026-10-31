import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import * as pty from "node-pty";
import {
	type Activity,
	isRemoteHost,
	type NewSessionRequest,
	type RemoteHost,
} from "../shared/types.ts";
import { claudeEnv } from "./accounts.ts";
import { lastLine, stripAnsi } from "./ansi.ts";
import type { CmuxResult } from "./cmux.ts";
import { accountCommand, untrustedHint } from "./sessions.ts";
import { createStateFile, readState } from "./stateFile.ts";
import type { SessionTty } from "./terminals.ts";
import { mirrorTrust, profileConfig } from "./trust.ts";
import { keychainService } from "./usage.ts";

export type CloudCredentials = {
	token: string;
	expiresAt: number;
	org: string;
};

export type CredentialOptions = {
	claudeBin?: string;
	claudeHome?: string;
	configFile?: string;
	run?: (
		file: string,
		args: string[],
		env: NodeJS.ProcessEnv,
	) => Promise<string>;
	now?: () => number;
};

const defaultClaudeHome = join(homedir(), ".claude");

const configFileOf = (claudeHome: string) =>
	claudeHome === defaultClaudeHome
		? join(homedir(), ".claude.json")
		: join(claudeHome, ".claude.json");

const expiryMarginMs = 60_000;
const expiredMessage = "Cloud sign-in expired: run claude once to refresh it";
const signedOutMessage = "Cloud sessions need claude signed in to claude.ai";

const runQuietly = (
	file: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<string> =>
	new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 15_000, env }, (error, stdout) =>
			error ? reject(new Error(`${file} ${args[0]} failed`)) : resolve(stdout),
		);
	});

const parseJsonQuietly = (text: string, what: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${what} is not valid JSON`);
	}
};

export type CredentialReader = {
	(): Promise<CloudCredentials>;
	forget?(): void;
};

const failureBackoffMs = 60_000;

export const cloudCredentials = ({
	claudeBin = "claude",
	claudeHome = defaultClaudeHome,
	configFile = configFileOf(claudeHome),
	run = runQuietly,
	now = Date.now,
}: CredentialOptions = {}): CredentialReader & { forget(): void } => {
	let cached: CloudCredentials | null = null;
	let pending: Promise<CloudCredentials> | null = null;
	let failure: { error: unknown; at: number } | null = null;
	const env = claudeEnv(
		claudeHome === defaultClaudeHome ? undefined : claudeHome,
	);

	const read = async (): Promise<CloudCredentials> => {
		const stored = parseJsonQuietly(
			await run(
				"security",
				["find-generic-password", "-s", keychainService(claudeHome), "-w"],
				env,
			).catch(() =>
				readFile(join(claudeHome, ".credentials.json"), "utf8").catch(() => {
					throw new Error(signedOutMessage);
				}),
			),
			"The stored Claude sign-in",
		) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
		const { accessToken, expiresAt } = stored?.claudeAiOauth ?? {};
		const config = parseJsonQuietly(
			await readFile(configFile, "utf8"),
			configFile,
		) as { oauthAccount?: { organizationUuid?: unknown } };
		const org = config?.oauthAccount?.organizationUuid;
		if (
			typeof accessToken !== "string" ||
			typeof expiresAt !== "number" ||
			typeof org !== "string"
		) {
			throw new Error(signedOutMessage);
		}
		return { token: accessToken, expiresAt, org };
	};

	const fresh = (credentials: CloudCredentials) =>
		credentials.expiresAt - expiryMarginMs > now();

	const load = async (): Promise<CloudCredentials> => {
		let credentials = await read();
		if (!fresh(credentials)) {
			await run(claudeBin, ["auth", "status"], env).catch(() => "");
			credentials = await read();
		}
		if (!fresh(credentials)) throw new Error(expiredMessage);
		return credentials;
	};

	const reader = async () => {
		if (cached && fresh(cached)) return cached;
		if (failure && now() - failure.at < failureBackoffMs) throw failure.error;
		pending ??= load()
			.then((credentials) => {
				cached = credentials;
				failure = null;
				return credentials;
			})
			.catch((error: unknown) => {
				failure = { error, at: now() };
				throw error;
			})
			.finally(() => {
				pending = null;
			});
		return pending;
	};

	return Object.assign(reader, {
		forget: () => {
			cached = null;
			failure = null;
		},
	});
};

export type PostTurnSummary = {
	status_category?: string;
	status_detail?: string;
	needs_action?: string;
};

export type CloudSessionInfo = {
	id: string;
	title?: string;
	session_status: string;
	session_url?: string;
	updated_at: string;
	external_metadata?: { post_turn_summary?: PostTurnSummary };
};

export type CloudEvent = {
	uuid: string;
	type: string;
	created_at: string;
	[field: string]: unknown;
};

type EnvironmentProvider = {
	kind: string;
	environment_id: string;
	name: string;
	bridge_info: {
		machine_name: string;
		directory: string;
		online: boolean;
	} | null;
};

export type CloudApi = {
	hosts(): Promise<CmuxResult<RemoteHost[]>>;
	create(
		environmentId: string,
		cwd: string,
		prompt: string,
		title?: string,
	): Promise<CmuxResult<string>>;
	get(id: string): Promise<CmuxResult<CloudSessionInfo>>;
	events(id: string, afterId: string | null): Promise<CmuxResult<CloudEvent[]>>;
	send(id: string, text: string): Promise<CmuxResult<null>>;
	archive(id: string): Promise<CmuxResult<null>>;
};

const apiBase = "https://api.anthropic.com";
const requestTimeoutMs = 30_000;

export const createCloudApi = ({
	credentials,
	fetch = globalThis.fetch,
}: {
	credentials: CredentialReader;
	fetch?: typeof globalThis.fetch;
}): CloudApi => {
	const call = async <T>(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<CmuxResult<T>> => {
		try {
			const { token, org } = await credentials();
			const response = await fetch(`${apiBase}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"x-organization-uuid": org,
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "ccr-byoc-2025-07-29",
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(requestTimeoutMs),
			});
			if (response.status === 401 || response.status === 403) {
				credentials.forget?.();
			}
			if (!response.ok) {
				return {
					ok: false,
					error: `Cloud API ${method} ${path.split("?")[0]} failed with HTTP ${response.status}`,
				};
			}
			return { ok: true, value: (await response.json()) as T };
		} catch (error) {
			return {
				ok: false,
				error: `Cloud API unreachable: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	};

	const unexpected = (request: string) => ({
		ok: false as const,
		error: `Cloud API ${request} answered in an unexpected shape`,
	});

	const sessionPath = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;

	return {
		async hosts() {
			const listed = await call<{ environments: EnvironmentProvider[] }>(
				"GET",
				"/v1/environment_providers",
			);
			if (!listed.ok) return listed;
			if (!Array.isArray(listed.value?.environments)) {
				return unexpected("GET /v1/environment_providers");
			}
			return {
				ok: true,
				value: listed.value.environments.flatMap(
					({ kind, environment_id, name, bridge_info }) =>
						kind === "bridge" && bridge_info?.online
							? [
									{
										id: environment_id,
										name,
										machine: bridge_info.machine_name,
										directory: bridge_info.directory,
									},
								]
							: [],
				),
			};
		},
		async create(environmentId, cwd, prompt, title) {
			const created = await call<{ id: string }>(
				"POST",
				"/v1/sessions?beta=true",
				{
					title,
					environment_id: environmentId,
					source: "remote-control",
					session_context: { sources: [], outcomes: [], cwd },
					events: [
						{
							type: "event",
							data: {
								type: "user",
								uuid: randomUUID(),
								session_id: "",
								parent_tool_use_id: null,
								message: { role: "user", content: prompt },
							},
						},
					],
				},
			);
			if (!created.ok) return created;
			return typeof created.value?.id === "string"
				? { ok: true, value: created.value.id }
				: unexpected("POST /v1/sessions");
		},
		async get(id) {
			const got = await call<CloudSessionInfo>(
				"GET",
				`${sessionPath(id)}?beta=true`,
			);
			if (!got.ok) return got;
			return typeof got.value?.session_status === "string"
				? got
				: unexpected(`GET ${sessionPath(id)}`);
		},
		async events(id, afterId) {
			const events: CloudEvent[] = [];
			let cursor = afterId;
			for (;;) {
				const page = await call<{ data: CloudEvent[]; has_more: boolean }>(
					"GET",
					`${sessionPath(id)}/events?beta=true&limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}`,
				);
				if (!page.ok) return page;
				if (!Array.isArray(page.value?.data)) {
					return unexpected(`GET ${sessionPath(id)}/events`);
				}
				events.push(...page.value.data);
				const last = page.value.data.at(-1);
				if (!page.value.has_more || !last) return { ok: true, value: events };
				cursor = last.uuid;
			}
		},
		async send(id, text) {
			const sent = await call("POST", `${sessionPath(id)}/events?beta=true`, {
				events: [
					{
						type: "user",
						uuid: randomUUID(),
						session_id: id,
						parent_tool_use_id: null,
						message: { role: "user", content: text },
					},
				],
			});
			return sent.ok ? { ok: true, value: null } : sent;
		},
		async archive(id) {
			const archived = await call(
				"POST",
				`${sessionPath(id)}/archive?beta=true`,
				{},
			);
			return archived.ok ? { ok: true, value: null } : archived;
		},
	};
};

const isGone = (result: CmuxResult<unknown>): boolean =>
	!result.ok && result.error.endsWith("failed with HTTP 404");

export type CloudRecord = {
	id: string;
	cwd: string;
	name: string;
	createdAt: number;
	configDir?: string;
	prompt?: string;
};

export type CloudSession = {
	id: string;
	cwd: string;
	name: string;
	configDir?: string;
	url: string;
	createdAt: number;
	updatedAt: number;
	activity: Activity;
	detail: string | null;
	transcript: string;
};

export type CloudSessions = {
	add(record: CloudRecord): void;
	remove(id: string): void;
	sessions(): CloudSession[];
	transcriptPath(id: string): string | null;
	send(id: string, text: string): Promise<CmuxResult<null>>;
	archive(id: string): Promise<CmuxResult<null>>;
	stop(): void;
};

const cloudIdPattern = /^session_[A-Za-z0-9]{1,128}$/;

const isCloudRecord = (value: unknown): value is CloudRecord => {
	if (typeof value !== "object" || value === null) return false;
	const { id, cwd, name, createdAt, configDir, prompt } = value as Record<
		string,
		unknown
	>;
	return (
		typeof id === "string" &&
		cloudIdPattern.test(id) &&
		typeof cwd === "string" &&
		typeof name === "string" &&
		typeof createdAt === "number" &&
		(configDir === undefined || typeof configDir === "string") &&
		(prompt === undefined || typeof prompt === "string")
	);
};

export const parseCloudRecords = (value: unknown): CloudRecord[] =>
	Array.isArray(value) ? value.filter(isCloudRecord) : [];

export const cloudActivity = (info: CloudSessionInfo): Activity => {
	if (info.session_status === "running") return "working";
	if (info.session_status === "requires_action") return "needs-you";
	if (
		info.session_status === "idle" &&
		info.external_metadata?.post_turn_summary?.needs_action
	) {
		return "needs-you";
	}
	return "idle";
};

const cloudDetail = (info: CloudSessionInfo): string | null => {
	const summary = info.external_metadata?.post_turn_summary;
	return summary?.needs_action || summary?.status_detail || null;
};

export const cloudUrl = (id: string) => `https://claude.ai/code/${id}`;

type Tracked = {
	record: CloudRecord;
	session: CloudSession;
	seenUpdatedAt: string | null;
	cursor: string | null;
};

export const createCloudSessions = async ({
	file,
	dir,
	apiFor,
	pollMs = 3000,
	onChange,
}: {
	file: string;
	dir: string;
	apiFor: (configDir?: string) => CloudApi;
	pollMs?: number;
	onChange: () => void;
}): Promise<CloudSessions> => {
	const stored = createStateFile<CloudRecord[]>(file);
	const tracked = new Map<string, Tracked>();
	const reported = new Map<string, string>();
	const mirrorOf = (id: string) => join(dir, `${id}.jsonl`);

	const track = (record: CloudRecord) =>
		tracked.set(record.id, {
			record,
			session: {
				...record,
				url: cloudUrl(record.id),
				updatedAt: record.createdAt,
				activity: "working",
				detail: null,
				transcript: mirrorOf(record.id),
			},
			seenUpdatedAt: null,
			cursor: null,
		});

	const openingPrompt = ({ prompt, createdAt }: CloudRecord) =>
		prompt === undefined
			? ""
			: `${JSON.stringify({
					type: "user",
					message: { role: "user", content: prompt },
					timestamp: new Date(createdAt).toISOString(),
				})}\n`;

	const persist = () =>
		stored.write([...tracked.values()].map(({ record }) => record));

	const report = (id: string, error: string) => {
		if (reported.get(id) === error) return;
		reported.set(id, error);
		console.error(`kanban cloud ${id}: ${error}`);
	};

	const untracked = (id: string) => ({
		ok: false as const,
		error: `${id} is not a cloud session on this board`,
	});

	const remove = (id: string) => {
		if (!tracked.delete(id)) return;
		reported.delete(id);
		persist();
		void rm(mirrorOf(id), { force: true });
		onChange();
	};

	const mirror = async (item: Tracked, events: CloudEvent[]) => {
		if (events.length === 0) return;
		await appendFile(
			item.session.transcript,
			events
				.map(
					(event) =>
						`${JSON.stringify({ ...event, timestamp: event.created_at })}\n`,
				)
				.join(""),
		);
		item.cursor = events.at(-1)?.uuid ?? item.cursor;
	};

	const pollOne = async (item: Tracked) => {
		const { id, configDir } = item.record;
		const api = apiFor(configDir);
		const got = await api.get(id);
		if (tracked.get(id) !== item) return;
		if (isGone(got)) return remove(id);
		if (!got.ok) return report(id, got.error);
		const info = got.value;
		if (info.session_status === "archived") return remove(id);
		const before = JSON.stringify(item.session);
		item.session = {
			...item.session,
			name: info.title?.trim() || item.record.name,
			url: info.session_url ?? cloudUrl(id),
			activity: cloudActivity(info),
			detail: cloudDetail(info),
			updatedAt: Date.parse(info.updated_at) || item.session.updatedAt,
		};
		let mirrored = false;
		if (info.updated_at !== item.seenUpdatedAt) {
			const events = await api.events(id, item.cursor);
			if (tracked.get(id) !== item) return;
			if (!events.ok) return report(id, events.error);
			try {
				await mirror(item, events.value);
			} catch (error) {
				return report(id, `mirror write failed (${error})`);
			}
			item.seenUpdatedAt = info.updated_at;
			mirrored = events.value.length > 0;
		}
		reported.delete(id);
		if (mirrored || JSON.stringify(item.session) !== before) onChange();
	};

	let polling: Promise<void> | null = null;
	const pollAll = () => {
		polling ??= Promise.all(
			[...tracked.values()].map((item) =>
				pollOne(item).catch((error: unknown) =>
					report(item.record.id, String(error)),
				),
			),
		)
			.then(() => undefined)
			.finally(() => {
				polling = null;
			});
		return polling;
	};

	await mkdir(dir, { recursive: true });
	for (const record of await readState(file, parseCloudRecords)) {
		track(record);
		await writeFile(mirrorOf(record.id), openingPrompt(record));
	}
	const timer = setInterval(pollAll, pollMs);
	void pollAll();

	return {
		add(record) {
			track(record);
			persist();
			void writeFile(mirrorOf(record.id), openingPrompt(record), { flag: "a" })
				.then(pollAll)
				.catch((error: unknown) => report(record.id, String(error)));
			onChange();
		},
		remove,
		sessions: () => [...tracked.values()].map(({ session }) => session),
		transcriptPath: (id) => tracked.get(id)?.session.transcript ?? null,
		async send(id, text) {
			const item = tracked.get(id);
			if (!item) return untracked(id);
			const sent = await apiFor(item.record.configDir).send(id, text);
			if (sent.ok) void pollAll();
			return sent;
		},
		async archive(id) {
			const item = tracked.get(id);
			if (!item) return untracked(id);
			const archived = await apiFor(item.record.configDir).archive(id);
			if (!archived.ok && !isGone(archived)) return archived;
			remove(id);
			return { ok: true, value: null };
		},
		stop: () => clearInterval(timer),
	};
};

export type CloudLaunch =
	| { ok: true; id: string; configDir?: string }
	| { ok: false; error: string };

export type CloudLauncher = (
	request: NewSessionRequest,
) => Promise<CloudLaunch>;

export type CloudPty = {
	onData(listener: (data: string) => void): unknown;
	onExit(listener: (event: { exitCode: number }) => void): unknown;
	kill(signal?: string): void;
};

export type CloudPtySpawn = (
	file: string,
	args: string[],
	options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
) => CloudPty;

const createdPattern =
	/Created cloud session[\s\S]*?claude\.ai\/code\/(session_[A-Za-z0-9]+)[^A-Za-z0-9]/;

const trustPromptPattern = /Yes,\s*I\s*trust\s*this\s*folder/;

export const parseCloudCreated = (output: string): string | null =>
	stripAnsi(output).match(createdPattern)?.[1] ?? null;

const nodePtySpawn: CloudPtySpawn = (file, args, options) =>
	pty.spawn(file, args, { name: "xterm-256color", ...options });

export const cloudBlocker = (
	cwd: string,
	git = "git",
): Promise<string | null> =>
	new Promise((resolve) => {
		if (!isAbsolute(cwd)) return resolve("cwd must be an absolute path");
		execFile(
			git,
			["-C", cwd, "rev-parse", "--verify", "--quiet", "HEAD"],
			{ timeout: 10_000 },
			(error) =>
				resolve(
					!error
						? null
						: error.code === 1
							? "Needs a first commit"
							: "Not a git repository",
				),
		);
	});

export type CloudLauncherOptions = {
	claudeBin: string;
	cswapBin?: string;
	defaultConfig?: string;
	profileOf?: (account: number) => string | null;
	blocker?: (cwd: string) => Promise<string | null>;
	spawnPty?: CloudPtySpawn;
	timeoutMs?: number;
};

export const cloudLauncher =
	({
		claudeBin,
		cswapBin = "cswap",
		defaultConfig = join(homedir(), ".claude.json"),
		profileOf = () => null,
		blocker = cloudBlocker,
		spawnPty = nodePtySpawn,
		timeoutMs = 60_000,
	}: CloudLauncherOptions): CloudLauncher =>
	async (request) => {
		const blocked = await blocker(request.cwd);
		if (blocked) return { ok: false, error: blocked };
		const profile =
			request.account === undefined ? null : profileOf(request.account);
		const { file, args, env } = accountCommand(
			claudeBin,
			cswapBin,
			request.account,
			[
				`--cloud=${request.prompt}`,
				...(request.name ? ["--name", request.name] : []),
			],
		);
		const landed = (id: string): CloudLaunch => ({
			ok: true,
			id,
			...(profile ? { configDir: profile } : {}),
		});
		const untrusted: CloudLaunch = {
			ok: false,
			error: untrustedHint(request.cwd, request.account),
		};
		const attempt = () =>
			new Promise<CloudLaunch>((resolve) => {
				let output = "";
				let settled = false;
				const terminal = spawnPty(file, args, {
					cwd: request.cwd,
					cols: 120,
					rows: 40,
					env,
				});
				const failed = (): CloudLaunch => {
					const detail = lastLine(output);
					return {
						ok: false,
						error: detail
							? `claude --cloud failed: ${detail}`
							: "claude --cloud failed",
					};
				};
				const finish = (result: CloudLaunch, running: boolean) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (running) {
						try {
							terminal.kill("SIGHUP");
						} catch {}
					}
					resolve(result);
				};
				const timer = setTimeout(() => finish(failed(), true), timeoutMs);
				terminal.onData((data) => {
					output += data;
					const id = parseCloudCreated(output);
					if (id) return finish(landed(id), true);
					if (trustPromptPattern.test(stripAnsi(output))) {
						finish(untrusted, true);
					}
				});
				terminal.onExit(() => {
					const id = parseCloudCreated(`${output}\n`);
					finish(id ? landed(id) : failed(), false);
				});
			});
		const launched = await attempt();
		if (
			launched === untrusted &&
			profile &&
			(await mirrorTrust(
				defaultConfig,
				profileConfig(profile),
				request.cwd,
			).catch(() => false))
		) {
			return attempt();
		}
		return launched;
	};

const realOrSame = (path: string) => realpath(path).catch(() => path);

const mainCheckoutOf = (cwd: string, git: string): Promise<string | null> =>
	new Promise((resolve) => {
		execFile(
			git,
			["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ timeout: 10_000 },
			(error, stdout) => resolve(error ? null : dirname(stdout.trim())),
		);
	});

export const remoteHostFor = async (
	api: CloudApi,
	hostId: string,
	cwd: string,
	git = "git",
): Promise<CmuxResult<RemoteHost>> => {
	const hosts = await api.hosts();
	if (!hosts.ok) return hosts;
	const host = hosts.value.find(({ id }) => id === hostId);
	if (!host) {
		return {
			ok: false,
			error: "That remote-control host is no longer running",
		};
	}
	const mainCheckout = await mainCheckoutOf(cwd, git);
	const served = await realOrSame(host.directory);
	const folders = await Promise.all(
		[cwd, ...(mainCheckout ? [mainCheckout] : [])].map(realOrSame),
	);
	return folders.includes(served)
		? { ok: true, value: host }
		: {
				ok: false,
				error: `${host.machine} serves ${host.directory}, not this folder`,
			};
};

export const runsOnBlocker =
	(
		apiOf: (account?: number) => CloudApi,
		blocker: (cwd: string) => Promise<string | null> = cloudBlocker,
		git = "git",
	) =>
	async (
		cwd: string,
		runsOn: string,
		account?: number,
	): Promise<string | null> => {
		if (runsOn === "local") return null;
		if (!isRemoteHost(runsOn)) return blocker(cwd);
		const host = await remoteHostFor(apiOf(account), runsOn, cwd, git);
		return host.ok ? null : host.error;
	};

export type RemoteLauncherOptions = {
	apiFor: (configDir?: string) => CloudApi;
	profileOf?: (account: number) => string | null;
	git?: string;
};

export const remoteLauncher =
	({
		apiFor,
		profileOf = () => null,
		git = "git",
	}: RemoteLauncherOptions): CloudLauncher =>
	async (request) => {
		const profile =
			request.account === undefined ? null : profileOf(request.account);
		const api = apiFor(profile ?? undefined);
		const host = await remoteHostFor(
			api,
			request.runsOn ?? "",
			request.cwd,
			git,
		);
		if (!host.ok) return host;
		const created = await api.create(
			host.value.id,
			host.value.directory,
			request.prompt,
			request.name,
		);
		if (!created.ok) return created;
		return {
			ok: true,
			id: created.value,
			...(profile ? { configDir: profile } : {}),
		};
	};

const cloudRefusal =
	"Open this cloud session on claude.ai to answer prompts or switch mode";

export const cloudTty = (
	store: Pick<CloudSessions, "send">,
	id: string,
): SessionTty => {
	const refused = async () => ({ ok: false as const, error: cloudRefusal });
	return {
		screen: async () => ({ ok: true, value: "" }),
		send: (text) => store.send(id, text),
		keys: refused,
		paste: refused,
		isOpen: () => true,
		close: () => {},
	};
};
