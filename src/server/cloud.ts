import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import type { Activity, NewSessionRequest } from "../shared/types.ts";
import { lastLine, stripAnsi } from "./ansi.ts";
import type { CmuxResult } from "./cmux.ts";
import { createStateFile, readState } from "./stateFile.ts";
import {
	type PtyScreen,
	type SessionTty,
	sharedAttachTty,
} from "./terminals.ts";
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
	run?: (file: string, args: string[]) => Promise<string>;
	now?: () => number;
};

const defaultClaudeHome = join(homedir(), ".claude");

const configFileOf = (claudeHome: string) =>
	claudeHome === defaultClaudeHome
		? join(homedir(), ".claude.json")
		: join(claudeHome, ".claude.json");

const expiryMarginMs = 60_000;
const expiredMessage = "Cloud sign-in expired: run claude once to refresh it";

const runQuietly = (file: string, args: string[]): Promise<string> =>
	new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 15_000 }, (error, stdout) =>
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

export const cloudCredentials = ({
	claudeBin = "claude",
	claudeHome = defaultClaudeHome,
	configFile = configFileOf(claudeHome),
	run = runQuietly,
	now = Date.now,
}: CredentialOptions = {}): (() => Promise<CloudCredentials>) => {
	let cached: CloudCredentials | null = null;

	const read = async (): Promise<CloudCredentials> => {
		const stored = parseJsonQuietly(
			await run("security", [
				"find-generic-password",
				"-s",
				keychainService(claudeHome),
				"-w",
			]),
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
			throw new Error("Cloud sessions need claude signed in to claude.ai");
		}
		return { token: accessToken, expiresAt, org };
	};

	const fresh = (credentials: CloudCredentials) =>
		credentials.expiresAt - expiryMarginMs > now();

	return async () => {
		if (cached && fresh(cached)) return cached;
		let credentials = await read();
		if (!fresh(credentials)) {
			await run(claudeBin, ["auth", "status"]).catch(() => "");
			credentials = await read();
		}
		if (!fresh(credentials)) throw new Error(expiredMessage);
		cached = credentials;
		return credentials;
	};
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

export type CloudApi = {
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
	credentials: () => Promise<CloudCredentials>;
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

	const sessionPath = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;

	return {
		get: (id) => call<CloudSessionInfo>("GET", `${sessionPath(id)}?beta=true`),
		async events(id, afterId) {
			const events: CloudEvent[] = [];
			let cursor = afterId;
			for (;;) {
				const page = await call<{ data: CloudEvent[]; has_more: boolean }>(
					"GET",
					`${sessionPath(id)}/events?beta=true&limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}`,
				);
				if (!page.ok) return page;
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

export type CloudRecord = {
	id: string;
	cwd: string;
	name: string;
	createdAt: number;
};

export type CloudSession = {
	id: string;
	cwd: string;
	name: string;
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
	const { id, cwd, name, createdAt } = value as Record<string, unknown>;
	return (
		typeof id === "string" &&
		cloudIdPattern.test(id) &&
		typeof cwd === "string" &&
		typeof name === "string" &&
		typeof createdAt === "number"
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
	api,
	pollMs = 3000,
	onChange,
}: {
	file: string;
	dir: string;
	api: CloudApi;
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

	const persist = () =>
		stored.write([...tracked.values()].map(({ record }) => record));

	const report = (id: string, error: string) => {
		if (reported.get(id) === error) return;
		reported.set(id, error);
		console.error(`kanban cloud ${id}: ${error}`);
	};

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
		const { id } = item.record;
		const got = await api.get(id);
		if (tracked.get(id) !== item) return;
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
		polling ??= Promise.all([...tracked.values()].map(pollOne))
			.then(() => undefined)
			.finally(() => {
				polling = null;
			});
		return polling;
	};

	await mkdir(dir, { recursive: true });
	for (const record of await readState(file, parseCloudRecords)) {
		track(record);
		await writeFile(mirrorOf(record.id), "");
	}
	const timer = setInterval(pollAll, pollMs);
	void pollAll();

	return {
		add(record) {
			track(record);
			persist();
			void writeFile(mirrorOf(record.id), "", { flag: "a" })
				.then(pollAll)
				.catch((error: unknown) => report(record.id, String(error)));
			onChange();
		},
		remove,
		sessions: () => [...tracked.values()].map(({ session }) => session),
		transcriptPath: (id) => tracked.get(id)?.session.transcript ?? null,
		async send(id, text) {
			if (!tracked.has(id)) {
				return {
					ok: false,
					error: `${id} is not a cloud session on this board`,
				};
			}
			const sent = await api.send(id, text);
			if (sent.ok) void pollAll();
			return sent;
		},
		async archive(id) {
			const archived = await api.archive(id);
			if (archived.ok) remove(id);
			return archived;
		},
		stop: () => clearInterval(timer),
	};
};

export type CloudLauncher = (
	request: NewSessionRequest,
) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;

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

export const parseCloudCreated = (output: string): string | null =>
	stripAnsi(output).match(createdPattern)?.[1] ?? null;

const nodePtySpawn: CloudPtySpawn = (file, args, options) =>
	pty.spawn(file, args, { name: "xterm-256color", ...options });

export const cloudLauncher =
	(
		claudeBin: string,
		spawnPty: CloudPtySpawn = nodePtySpawn,
		timeoutMs = 60_000,
	): CloudLauncher =>
	(request) =>
		new Promise((resolve) => {
			let output = "";
			let settled = false;
			const terminal = spawnPty(
				claudeBin,
				[
					`--cloud=${request.prompt}`,
					...(request.name ? ["--name", request.name] : []),
				],
				{ cwd: request.cwd, cols: 120, rows: 40, env: process.env },
			);
			const failed = () => {
				const detail = lastLine(output);
				return {
					ok: false as const,
					error: detail
						? `claude --cloud failed: ${detail}`
						: "claude --cloud failed",
				};
			};
			const finish = (
				result: { ok: true; id: string } | { ok: false; error: string },
				running: boolean,
			) => {
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
				if (id) finish({ ok: true, id }, true);
			});
			terminal.onExit(() => {
				const id = parseCloudCreated(`${output}\n`);
				finish(id ? { ok: true, id } : failed(), false);
			});
		});

const cloudRefusal =
	"Open this cloud session's terminal view on the board, or open it on claude.ai, to answer prompts or switch mode";

export const cloudTty = (
	store: Pick<CloudSessions, "send">,
	id: string,
	live: () => PtyScreen | null = () => null,
): SessionTty => {
	const terminal = sharedAttachTty({ live });
	const refused = async () => ({ ok: false as const, error: cloudRefusal });
	return {
		screen: () =>
			live() ? terminal.screen() : Promise.resolve({ ok: true, value: "" }),
		send: (text) => store.send(id, text),
		keys: (keys) => (live() ? terminal.keys(keys) : refused()),
		paste: (text) => (live() ? terminal.paste(text) : refused()),
		isOpen: () => true,
		close: () => {},
	};
};
