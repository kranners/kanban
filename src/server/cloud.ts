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
import { asObject, asString } from "./ingest/json.ts";
import { SAFE_SESSION_RULES, safeVerdict } from "./safePrompts.ts";
import { accountCommand, untrustedHint } from "./sessions.ts";
import { createStateFile, readState } from "./stateFile.ts";
import type { RemotePrompt, SessionTty } from "./terminals.ts";
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
	external_metadata?: {
		post_turn_summary?: PostTurnSummary;
		pending_action?: unknown;
		pending_actions?: unknown;
	};
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
	/**
	 * Events after afterId. With onPage each page is handed over as it
	 * arrives and none are kept, so a long history never sits in memory
	 * whole; without it they are all returned.
	 */
	events(
		id: string,
		afterId: string | null,
		onPage?: (page: CloudEvent[]) => Promise<void>,
	): Promise<CmuxResult<CloudEvent[]>>;
	send(id: string, text: string): Promise<CmuxResult<null>>;
	respond(
		id: string,
		requestId: string,
		response: Record<string, unknown>,
	): Promise<CmuxResult<null>>;
	archive(id: string): Promise<CmuxResult<null>>;
	unarchive(id: string): Promise<CmuxResult<null>>;
	profile(): Promise<CmuxResult<unknown>>;
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

	const post = async (
		id: string,
		event: Record<string, unknown>,
	): Promise<CmuxResult<null>> => {
		const sent = await call("POST", `${sessionPath(id)}/events?beta=true`, {
			events: [{ uuid: randomUUID(), ...event }],
		});
		return sent.ok ? { ok: true, value: null } : sent;
	};

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
		async events(id, afterId, onPage) {
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
				if (onPage) await onPage(page.value.data);
				else events.push(...page.value.data);
				const last = page.value.data.at(-1);
				if (!page.value.has_more || !last) return { ok: true, value: events };
				cursor = last.uuid;
			}
		},
		send: (id, text) =>
			post(id, {
				type: "user",
				session_id: id,
				parent_tool_use_id: null,
				message: { role: "user", content: text },
			}),
		respond: (id, requestId, response) =>
			post(id, {
				type: "control_response",
				response: { subtype: "success", request_id: requestId, response },
			}),
		async archive(id) {
			// An explicit close reads the sign-in afresh, not a failure cached a minute ago.
			credentials.forget?.();
			const archived = await call(
				"POST",
				`${sessionPath(id)}/archive?beta=true`,
				{},
			);
			return archived.ok ? { ok: true, value: null } : archived;
		},
		async unarchive(id) {
			const restored = await call(
				"POST",
				`${sessionPath(id)}/unarchive?beta=true`,
				{},
			);
			return restored.ok ? { ok: true, value: null } : restored;
		},
		profile: () => call("GET", "/api/oauth/profile"),
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
	pending(id: string): RemotePrompt | null;
	/** Every prompt the session is waiting on, oldest first. */
	prompts(id: string): RemotePrompt[];
	/**
	 * Approves an open prompt the safe set allows, granting the session the
	 * whole input-free safe set for the rest of its life, so it stops asking
	 * for those tools.
	 */
	approveSafe(id: string, requestId: string): Promise<CmuxResult<null>>;
	choose(
		id: string,
		requestId: string,
		label: string,
	): Promise<CmuxResult<null>>;
	answer(
		id: string,
		requestId: string,
		answers: Record<string, string>,
	): Promise<CmuxResult<null>>;
	/**
	 * Archives a session on claude.ai and stops showing it. When claude.ai
	 * cannot be reached or refuses, the card still leaves the board and the
	 * result says the remote session was not ended, unless claude.ai last
	 * reported it working.
	 */
	archive(id: string): Promise<CmuxResult<CloudArchive>>;
	/** What the board knows of a cloud session it shows, to bring it back later. */
	record(id: string): CloudRecord | null;
	/** Unarchives a session on claude.ai and shows it on the board again. */
	restore(record: CloudRecord): Promise<CmuxResult<null>>;
	stop(): void;
};

/** How an exit left a cloud session: archived on claude.ai, or only taken off the board. */
export type CloudArchive = { remote: true } | { remote: false; reason: string };

export const localRemovalNote = (reason: string) =>
	`removed from the board only: the cloud session was not ended on claude.ai (${reason})`;

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

export const allowOnce = "Yes";
export const allowAlways = "Yes, and don't ask again";
export const refuseOnce = "No";
export const rejection =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

type OpenAction = Omit<RemotePrompt, "options">;
type Asked = { suggestions: unknown[]; remembers: boolean };
type CloudPrompt = RemotePrompt & { suggestions: unknown[] };

const waitingOn = (info: CloudSessionInfo): OpenAction[] => {
	if (info.session_status !== "requires_action") return [];
	const metadata = info.external_metadata;
	const listed = Array.isArray(metadata?.pending_actions)
		? metadata.pending_actions
		: [metadata?.pending_action];
	return listed.flatMap((value) => {
		const action = asObject(value);
		const requestId = asString(action?.request_id);
		const toolName = asString(action?.tool_name);
		if (!action || !requestId || !toolName) return [];
		return [
			{
				requestId,
				toolUseId: asString(action.tool_use_id),
				toolName,
				title: asString(action.display_tool_name) ?? toolName,
				input: asObject(action.input) ?? {},
			},
		];
	});
};

const askedOf = (event: CloudEvent): [string, Asked] | null => {
	const request = asObject(event.request);
	const requestId = asString(event.request_id);
	if (request?.subtype !== "can_use_tool" || !requestId) return null;
	const suggestions = Array.isArray(request.permission_suggestions)
		? request.permission_suggestions
		: [];
	return [
		requestId,
		{
			suggestions,
			remembers:
				suggestions.length > 0 && request.server_policy_ask_only !== true,
		},
	];
};

const promptFor = (action: OpenAction, asked?: Asked): CloudPrompt => ({
	...action,
	options: asked?.remembers
		? [allowOnce, allowAlways, refuseOnce]
		: [allowOnce, refuseOnce],
	suggestions: asked?.suggestions ?? [],
});

/** The permission update that grants a cloud session the safe set for the rest of its life. */
export const safeSessionGrant = () => [
	{
		type: "addRules",
		rules: SAFE_SESSION_RULES.map((toolName) => ({ toolName })),
		behavior: "allow",
		destination: "session",
	},
];

const answering = (prompt: CloudPrompt) => ({
	...(prompt.toolUseId !== null && { toolUseID: prompt.toolUseId }),
});

const decisionFor = (
	prompt: CloudPrompt,
	label: string,
): Record<string, unknown> | null => {
	if (!prompt.options.includes(label)) return null;
	if (label === refuseOnce) {
		return {
			behavior: "deny",
			message: rejection,
			interrupt: true,
			...answering(prompt),
			decisionClassification: "user_reject",
		};
	}
	const always = label === allowAlways;
	return {
		behavior: "allow",
		updatedInput: prompt.input,
		...(always && { updatedPermissions: prompt.suggestions }),
		...answering(prompt),
		decisionClassification: always ? "user_permanent" : "user_temporary",
		tool_name: prompt.toolName,
	};
};

type Tracked = {
	record: CloudRecord;
	session: CloudSession;
	seenUpdatedAt: string | null;
	/** The newest mirrored event ids, for rereading late ones. */
	mirrored: string[];
	/** Every mirrored event id. */
	seen: Set<string>;
	echoes: string[];
	waiting: OpenAction[];
	asked: Map<string, Asked>;
	answered: Map<string, number>;
	/** What claude.ai's last answer to a poll said, null until one answers. */
	polledActivity: Activity | null;
};

const lateEventReach = 50;
const mirroredKept = 1000;

/** At most this many events, or about this many bytes, go into one write of a mirror. */
export type MirrorBatch = { events: number; bytes: number };
const defaultMirrorBatch: MirrorBatch = { events: 500, bytes: 8 * 1024 * 1024 };

export const createCloudSessions = async ({
	file,
	dir,
	apiFor,
	pollMs = 3000,
	answerGraceMs = 60_000,
	mirrorBatch = defaultMirrorBatch,
	append = appendFile,
	onChange,
}: {
	file: string;
	dir: string;
	apiFor: (configDir?: string) => CloudApi;
	pollMs?: number;
	answerGraceMs?: number;
	mirrorBatch?: MirrorBatch;
	/** Appends a batch of mirrored events to a transcript. */
	append?: (path: string, text: string) => Promise<void>;
	onChange: () => void;
}): Promise<CloudSessions> => {
	const stored = createStateFile<CloudRecord[]>(file);
	const tracked = new Map<string, Tracked>();
	/** Sessions taken off the board without claude.ai archiving them, for undo. */
	const localOnly = new Set<string>();
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
			mirrored: [],
			seen: new Set(),
			echoes: record.prompt === undefined ? [] : [record.prompt],
			waiting: [],
			asked: new Map(),
			answered: new Map(),
			polledActivity: null,
		});

	const promptLine = (text: string, at: number) =>
		`${JSON.stringify({
			type: "user",
			message: { role: "user", content: text },
			timestamp: new Date(at).toISOString(),
		})}\n`;

	const openingPrompt = ({ prompt, createdAt }: CloudRecord) =>
		prompt === undefined ? "" : promptLine(prompt, createdAt);

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

	const echoed = (item: Tracked, event: CloudEvent) => {
		const content = (event.message as { content?: unknown } | undefined)
			?.content;
		const index =
			event.type === "user" && typeof content === "string"
				? item.echoes.indexOf(content)
				: -1;
		if (index === -1) return false;
		item.echoes.splice(index, 1);
		return true;
	};

	const trackPrompts = (item: Tracked, events: CloudEvent[]) => {
		for (const event of events) {
			const asked = askedOf(event);
			if (asked) item.asked.set(...asked);
		}
	};

	const openPrompts = (item: Tracked): CloudPrompt[] => {
		const now = Date.now();
		return item.waiting
			.filter(
				({ requestId }) =>
					now - (item.answered.get(requestId) ?? -answerGraceMs) >=
					answerGraceMs,
			)
			.map((action) => promptFor(action, item.asked.get(action.requestId)));
	};

	// Written in bounded batches, each recorded as mirrored once it lands,
	// so a long history read after a restart never becomes one giant string
	// and a failed write resumes from the last batch that landed.
	const mirror = async (item: Tracked, events: CloudEvent[]) => {
		const fresh = events.filter((event) => !item.seen.has(event.uuid));
		trackPrompts(item, fresh);
		let lines: string[] = [];
		let ids: string[] = [];
		let bytes = 0;
		let wrote = false;
		const flush = async () => {
			if (lines.length > 0) {
				await append(item.session.transcript, lines.join(""));
				wrote = true;
			}
			for (const uuid of ids) item.seen.add(uuid);
			item.mirrored.push(...ids);
			if (item.mirrored.length > mirroredKept) {
				item.mirrored.splice(0, item.mirrored.length - mirroredKept);
			}
			lines = [];
			ids = [];
			bytes = 0;
		};
		for (const event of fresh) {
			ids.push(event.uuid);
			if (!echoed(item, event)) {
				const line = `${JSON.stringify({ ...event, timestamp: event.created_at })}\n`;
				lines.push(line);
				bytes += line.length;
			}
			if (lines.length >= mirrorBatch.events || bytes >= mirrorBatch.bytes) {
				await flush();
			}
		}
		await flush();
		return wrote;
	};

	const pollOne = async (item: Tracked) => {
		const { id, configDir } = item.record;
		const api = apiFor(configDir);
		const got = await api.get(id);
		if (tracked.get(id) !== item) return;
		if (isGone(got)) return remove(id);
		if (!got.ok) {
			// Never heard from: don't keep claiming it is working.
			if (item.polledActivity === null && item.session.activity === "working") {
				item.session = { ...item.session, activity: "idle", detail: got.error };
				onChange();
			}
			return report(id, got.error);
		}
		const info = got.value;
		if (info.session_status === "archived") return remove(id);
		item.polledActivity = cloudActivity(info);
		const before = JSON.stringify(item.session);
		item.waiting = waitingOn(info);
		item.session = {
			...item.session,
			name: info.title?.trim() || item.record.name,
			url: info.session_url ?? cloudUrl(id),
			activity: cloudActivity(info),
			detail: cloudDetail(info),
			updatedAt: Date.parse(info.updated_at) || item.session.updatedAt,
		};
		let mirrored = false;
		const unread = item.waiting.some(
			({ requestId }) => !item.asked.has(requestId),
		);
		if (info.updated_at !== item.seenUpdatedAt || unread) {
			const stale = new Error("The session left the board");
			let events: CmuxResult<CloudEvent[]>;
			try {
				events = await api.events(
					id,
					item.mirrored.at(-lateEventReach - 1) ?? null,
					async (page) => {
						if (tracked.get(id) !== item) throw stale;
						if (await mirror(item, page)) mirrored = true;
					},
				);
				if (
					events.ok &&
					tracked.get(id) === item &&
					(await mirror(item, events.value))
				) {
					mirrored = true;
				}
			} catch (error) {
				if (error === stale) return;
				if (mirrored) onChange();
				return report(id, `mirror write failed (${error})`);
			}
			if (tracked.get(id) !== item) return;
			if (!events.ok) {
				if (mirrored) onChange();
				return report(id, events.error);
			}
			item.seenUpdatedAt = info.updated_at;
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

	const closed = {
		ok: false as const,
		error: "That prompt is no longer open",
	};

	const respond = async (
		id: string,
		requestId: string,
		decide: (prompt: CloudPrompt) => Record<string, unknown> | null,
	): Promise<CmuxResult<null>> => {
		const item = tracked.get(id);
		const prompt = item
			? openPrompts(item).find((open) => open.requestId === requestId)
			: undefined;
		const response = prompt ? decide(prompt) : null;
		if (!item || !response) return closed;
		item.answered.set(requestId, Date.now());
		const sent = await apiFor(item.record.configDir).respond(
			id,
			requestId,
			response,
		);
		if (!sent.ok) {
			item.answered.delete(requestId);
			return sent;
		}
		if (openPrompts(item).length === 0) {
			item.session = { ...item.session, activity: "working", detail: null };
		}
		onChange();
		void pollAll();
		return sent;
	};

	await mkdir(dir, { recursive: true });
	for (const record of await readState(file, parseCloudRecords)) {
		track(record);
		await writeFile(mirrorOf(record.id), openingPrompt(record));
	}
	const timer = setInterval(pollAll, pollMs);
	void pollAll();

	const add = (record: CloudRecord) => {
		track(record);
		persist();
		void writeFile(mirrorOf(record.id), openingPrompt(record), { flag: "a" })
			.then(pollAll)
			.catch((error: unknown) => report(record.id, String(error)));
		onChange();
	};

	return {
		add,
		remove,
		sessions: () => [...tracked.values()].map(({ session }) => session),
		transcriptPath: (id) => tracked.get(id)?.session.transcript ?? null,
		pending(id) {
			const item = tracked.get(id);
			const prompt = item ? openPrompts(item).at(-1) : undefined;
			if (!prompt) return null;
			const { suggestions: _, ...shown } = prompt;
			return shown;
		},
		prompts(id) {
			const item = tracked.get(id);
			return item
				? openPrompts(item).map(({ suggestions: _, ...shown }) => shown)
				: [];
		},
		approveSafe(id, requestId) {
			const item = tracked.get(id);
			const prompt = item
				? openPrompts(item).find((open) => open.requestId === requestId)
				: undefined;
			if (!prompt) return Promise.resolve(closed);
			const verdict = safeVerdict(prompt.toolName, prompt.input);
			if (!verdict.safe) {
				return Promise.resolve({
					ok: false,
					error: `That prompt is not in the safe set: ${verdict.reason}`,
				});
			}
			return respond(id, requestId, (open) => ({
				behavior: "allow",
				updatedInput: open.input,
				updatedPermissions: safeSessionGrant(),
				...answering(open),
				decisionClassification: "user_permanent",
				tool_name: open.toolName,
			}));
		},
		choose: (id, requestId, label) =>
			respond(id, requestId, (prompt) => decisionFor(prompt, label)),
		answer: (id, requestId, answers) =>
			respond(id, requestId, (prompt) => ({
				behavior: "allow",
				updatedInput: { ...prompt.input, answers },
				...answering(prompt),
				decisionClassification: "user_temporary",
				tool_name: prompt.toolName,
			})),
		async send(id, text) {
			const item = tracked.get(id);
			if (!item) return untracked(id);
			const forget = () => {
				const index = item.echoes.lastIndexOf(text);
				if (index !== -1) item.echoes.splice(index, 1);
			};
			item.echoes.push(text);
			const sent = await apiFor(item.record.configDir).send(id, text);
			if (!sent.ok) {
				forget();
				return sent;
			}
			await appendFile(item.session.transcript, promptLine(text, Date.now()))
				.then(onChange)
				.catch((error: unknown) => {
					forget();
					report(id, `mirror write failed (${error})`);
				});
			void pollAll();
			return sent;
		},
		async archive(id) {
			const item = tracked.get(id);
			if (!item) return untracked(id);
			const archived = await apiFor(item.record.configDir).archive(id);
			if (archived.ok || isGone(archived)) {
				localOnly.delete(id);
				remove(id);
				return { ok: true, value: { remote: true } };
			}
			if (tracked.get(id) !== item)
				return { ok: true, value: { remote: true } };
			// claude.ai is unreachable, signed out or refusing: the card still
			// leaves the board, but not one claude.ai last said was working.
			if (item.polledActivity === "working") {
				return {
					ok: false,
					error: `${archived.error}; claude.ai last said it was working, so it stays on the board until it stops`,
				};
			}
			report(id, `removed from the board only: ${archived.error}`);
			localOnly.add(id);
			remove(id);
			return { ok: true, value: { remote: false, reason: archived.error } };
		},
		record: (id) => tracked.get(id)?.record ?? null,
		async restore(record) {
			if (tracked.has(record.id)) return { ok: true, value: null };
			// One only taken off the board was never archived: put it back as is.
			if (localOnly.delete(record.id)) {
				add(record);
				return { ok: true, value: null };
			}
			const restored = await apiFor(record.configDir).unarchive(record.id);
			if (!restored.ok) return restored;
			if (!tracked.has(record.id)) add(record);
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

/** The permission modes claude --cloud takes. */
export const cloudPermissionModes = [
	"acceptEdits",
	"auto",
	"bypassPermissions",
	"dontAsk",
	"plan",
	"manual",
] as const;
export type CloudPermissionMode = (typeof cloudPermissionModes)[number];
export const defaultCloudPermissionMode: CloudPermissionMode = "auto";

/**
 * The mode cloud sessions start in: KANBAN_CLOUD_PERMISSION_MODE when it
 * names one, else auto, the one mode --cloud forwards that runs unattended
 * without asking for every tool.
 */
export const cloudPermissionMode = (
	value: string | undefined = process.env.KANBAN_CLOUD_PERMISSION_MODE,
): CloudPermissionMode =>
	cloudPermissionModes.find((mode) => mode === value?.trim()) ??
	defaultCloudPermissionMode;

export type CloudLauncherOptions = {
	claudeBin: string;
	/** The mode every cloud session starts in. */
	permissionMode?: CloudPermissionMode;
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
		permissionMode = cloudPermissionMode(),
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
				"--permission-mode",
				permissionMode,
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
	"Open this cloud session on claude.ai to interrupt it or switch mode";

export const cloudTty = (
	store: Pick<CloudSessions, "send" | "pending" | "choose" | "answer">,
	id: string,
): SessionTty => {
	const refused = async () => ({ ok: false as const, error: cloudRefusal });
	return {
		screen: async () => ({ ok: true, value: "" }),
		send: (text) => store.send(id, text),
		prompts: {
			pending: () => store.pending(id),
			choose: (requestId, label) => store.choose(id, requestId, label),
			answer: (requestId, answers) => store.answer(id, requestId, answers),
		},
		keys: refused,
		paste: refused,
		isOpen: () => true,
		close: () => {},
	};
};
