// The runner's conversation with the hub: register, heartbeat every few
// seconds, and hold a long poll open for launch and stop commands. Any
// failure (hub restarting, network down, machine just woke) is retried; a
// heartbeat the hub doesn't recognise means it restarted, so register again.
import { arch, homedir, hostname, platform, release, uptime } from "node:os";
import {
	heartbeatMs as defaultHeartbeatMs,
	type RunnerCommand,
	type RunnerCommandResult,
	type RunnerRegistration,
	type RunnerReport,
	runnerProtocol,
} from "../shared/runners.ts";
import type { FolderBrowse } from "../shared/types.ts";
import { browseFolder } from "./browse.ts";
import type { RunnerConfig } from "./config.ts";
import type { SessionManager } from "./sessions.ts";
import type { SignalSampler } from "./signals.ts";
import { processStats, type UsageSampler } from "./usage.ts";

export type RunnerClientOptions = {
	config: RunnerConfig;
	sessions: SessionManager;
	sample: UsageSampler;
	/** Placement signals; reported only, and left out when not given. */
	signals?: SignalSampler;
	fetch?: typeof fetch;
	log?: (line: string) => void;
	retryMs?: number;
	/** Told the hub's runner.js version at each registration, to update itself when it differs. */
	onVersion?: (version: string) => void;
	/** Lists a folder for the board's folder browser; this disk by default. */
	browse?: (
		path: string | null,
		hubHome: string | null,
	) => Promise<FolderBrowse>;
};

export type RunnerClient = {
	stop(): Promise<void>;
	/** Resolves once the first registration succeeds; for tests. */
	registered: Promise<string>;
};

const wait = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

// Boot time rounded to the minute: stable across sleep, so the hub can tell a
// laptop that slept from one that rebooted.
const bootedAt = () =>
	Math.round((Date.now() - uptime() * 1000) / 60_000) * 60_000;

export const startRunnerClient = ({
	config,
	sessions,
	sample,
	signals,
	fetch: fetchImpl = fetch,
	log = console.error,
	retryMs = 5_000,
	onVersion = () => {},
	browse = (path, hubHome) =>
		browseFolder(path, {
			machine: config.name,
			home: homedir(),
			hubHome,
			paths: config.paths,
		}),
}: RunnerClientOptions): RunnerClient => {
	const stopping = new AbortController();
	const headers = {
		authorization: `Bearer ${config.token}`,
		"content-type": "application/json",
	};
	let id: string | null = null;
	let heartbeatEvery = defaultHeartbeatMs;
	let pollWait = 25_000;
	let lastError = "";
	let onRegistered: (id: string) => void = () => {};
	const registered = new Promise<string>((resolve) => {
		onRegistered = resolve;
	});

	const complain = (what: string) => {
		// Say each distinct problem once, not every five seconds.
		if (what !== lastError) log(`kanban-runner: ${what}`);
		lastError = what;
	};

	const report = async (): Promise<RunnerReport> => {
		const usage = await sample();
		const placement = await signals?.().catch(() => undefined);
		const pids = sessions.pids();
		const stats = await processStats([...pids.values()]);
		return {
			protocol: runnerProtocol,
			name: config.name,
			hostname: hostname(),
			platform: platform(),
			arch: arch(),
			release: release(),
			bootedAt: bootedAt(),
			cap: config.cap,
			usage,
			...(placement ? { signals: placement } : {}),
			sessions: sessions.list().map((session) => {
				const pid = pids.get(session.id);
				const stat = pid === undefined ? undefined : stats.get(pid);
				return stat
					? { ...session, cpuPercent: stat.cpuPercent, rss: stat.rss }
					: session;
			}),
		};
	};

	const call = (
		path: string,
		init: RequestInit & { timeoutMs: number },
	): Promise<Response> =>
		fetchImpl(`${config.hub}${path}`, {
			...init,
			headers,
			signal: AbortSignal.any([
				stopping.signal,
				AbortSignal.timeout(init.timeoutMs),
			]),
		});

	const register = async (): Promise<void> => {
		const response = await call("/api/runners/register", {
			method: "POST",
			body: JSON.stringify(await report()),
			timeoutMs: 10_000,
		});
		if (response.status === 401 || response.status === 403) {
			throw new Error(`the hub refused the token (${response.status})`);
		}
		if (!response.ok) throw new Error(`register answered ${response.status}`);
		const body = (await response.json()) as RunnerRegistration;
		id = body.id;
		heartbeatEvery = body.heartbeatMs;
		pollWait = body.pollWaitMs;
		if (typeof body.runnerVersion === "string") onVersion(body.runnerVersion);
		log(`kanban-runner: registered with ${config.hub} as ${id}`);
		lastError = "";
		onRegistered(id);
	};

	const heartbeat = async (): Promise<void> => {
		if (id === null) return register();
		const response = await call(`/api/runners/${id}/heartbeat`, {
			method: "POST",
			body: JSON.stringify(await report()),
			timeoutMs: 10_000,
		});
		if (response.status === 404) {
			id = null;
			return register();
		}
		if (!response.ok) throw new Error(`heartbeat answered ${response.status}`);
		lastError = "";
	};

	const answer = async (commandId: string, result: RunnerCommandResult) => {
		try {
			await call(`/api/runners/${id}/commands/${commandId}`, {
				method: "POST",
				body: JSON.stringify(result),
				timeoutMs: 10_000,
			});
		} catch (error) {
			complain(`couldn't answer ${commandId}: ${(error as Error).message}`);
		}
	};

	const run = async (command: RunnerCommand) => {
		if (command.type === "browse") {
			// Only looks: nothing changed, so no heartbeat is owed.
			const found = await browse(command.path, command.hubHome).catch(
				(error: Error): FolderBrowse => ({ ok: false, error: error.message }),
			);
			await answer(command.commandId, found);
			return;
		}
		const result =
			command.type === "launch"
				? await sessions.launch(command)
				: await sessions.stop(command.sessionId, command.force);
		await answer(command.commandId, result);
		// Report the change now rather than at the next beat.
		void heartbeat().catch(() => {});
	};

	const beatLoop = async () => {
		while (!stopping.signal.aborted) {
			try {
				await heartbeat();
			} catch (error) {
				if (!stopping.signal.aborted)
					complain(`can't reach ${config.hub}: ${(error as Error).message}`);
			}
			await wait(id === null ? retryMs : heartbeatEvery, stopping.signal);
		}
	};

	const pollLoop = async () => {
		await registered;
		while (!stopping.signal.aborted) {
			if (id === null) {
				await wait(retryMs, stopping.signal);
				continue;
			}
			try {
				const response = await call(
					`/api/runners/${id}/commands?wait=${pollWait}`,
					{ method: "GET", timeoutMs: pollWait + 10_000 },
				);
				if (!response.ok) {
					await wait(retryMs, stopping.signal);
					continue;
				}
				const { commands } = (await response.json()) as {
					commands: RunnerCommand[];
				};
				for (const command of commands) void run(command);
			} catch {
				await wait(retryMs, stopping.signal);
			}
		}
	};

	const loops = Promise.all([beatLoop(), pollLoop()]);
	return {
		registered,
		async stop() {
			stopping.abort();
			onRegistered("");
			await loops;
		},
	};
};
