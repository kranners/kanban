import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { cswapRoot } from "./accounts.ts";
import { type ProjectsConfig, parseProjectsConfig } from "./projects.ts";

export type AuthConfig =
	| { mode: "off" }
	| { mode: "access"; team: string; aud: string };

export type Config = {
	port: number;
	/** The first address in `hosts`, kept for callers that need just one. */
	host: string;
	/** Every address the board listens on; always includes a loopback one. */
	hosts: string[];
	/** Shared secret for machine-to-machine calls (runners, spike); null when unset. */
	runnerToken: string | null;
	/** How many Claude sessions this Mac's own runner is meant to carry. */
	runnerCap: number;
	/** Runner names to list (as offline) before they first check in. */
	expectedRunners: string[];
	/** Each runner's address as the proxy in front of the board sees it, for enrolment. */
	runnerAddresses: string | undefined;
	/** Runners that never take a personal job. */
	plainOnlyRunners: string[];
	/** Runners told of a new runner.js last. */
	updateLastRunners: string[];
	auth: AuthConfig;
	origins: string[];
	claudeBin: string;
	cmuxBin: string;
	cswapBin: string;
	cswapRoot: string;
	claudeHome: string;
	dist: string;
	auditLog: string;
	stateDir: string;
	/** Where Butler's projects come from, for the Projects view. */
	projects: ProjectsConfig;
};

const repoRoot = resolve(import.meta.dirname, "../..");
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export const isLoopback = (host: string): boolean =>
	loopbackHosts.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

const terminalShimDir = /\/cmux-cli-shims(\/|$)/;

const isExecutableFile = (file: string): boolean => {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
};

export const findClaude = (path = ""): string =>
	path
		.split(delimiter)
		.filter((dir) => dir !== "" && !terminalShimDir.test(dir))
		.map((dir) => join(dir, "claude"))
		.find(isExecutableFile) ?? "claude";

const defaultPort = 7420;

const defaultStateDir = (port: number): string =>
	join(
		homedir(),
		".local/state",
		port === defaultPort ? "kanban" : `kanban-${port}`,
	);

const parsePort = (raw: string | undefined): number => {
	if (raw === undefined || raw === "") return defaultPort;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`KANBAN_PORT must be a port number, got "${raw}"`);
	}
	return port;
};

const wildcardHosts = new Set(["0.0.0.0", "::"]);

// KANBAN_HOST is one address or a comma-separated list, such as
// `127.0.0.1,10.100.0.11` for loopback plus the WireGuard address. Loopback
// stays bound unless a wildcard already covers it, so the board's own agents,
// hooks and the Cloudflare tunnel keep reaching it.
export const parseHosts = (raw: string | undefined): string[] => {
	const listed = (raw ?? "")
		.split(",")
		.map((host) => host.trim())
		.filter((host) => host !== "");
	for (const host of listed) {
		if (!/^[A-Za-z0-9.:_-]+$/.test(host)) {
			throw new Error(`KANBAN_HOST has an invalid address: "${host}"`);
		}
	}
	const hosts = [...new Set(listed)];
	if (!hosts.some((host) => isLoopback(host) || wildcardHosts.has(host))) {
		hosts.unshift("127.0.0.1");
	}
	return hosts;
};

export const runnerTokenPattern = /^[A-Za-z0-9_-]{32,128}$/;

const parseRunnerToken = (raw: string | undefined): string | null => {
	if (raw === undefined || raw === "") return null;
	if (!runnerTokenPattern.test(raw)) {
		// Never echo the value: it is a secret even when malformed.
		throw new Error(
			"KANBAN_RUNNER_TOKEN must be 32-128 characters of A-Z, a-z, 0-9, _ or - (try `openssl rand -hex 32`)",
		);
	}
	return raw;
};

const defaultRunnerCap = 4;

export const parseRunnerCap = (raw: string | undefined): number => {
	if (raw === undefined || raw === "") return defaultRunnerCap;
	const cap = Number(raw);
	if (!Number.isInteger(cap) || cap < 1 || cap > 64) {
		throw new Error(`KANBAN_RUNNER_CAP must be 1-64, got "${raw}"`);
	}
	return cap;
};

const parseAuth = (env: NodeJS.ProcessEnv, hosts: string[]): AuthConfig => {
	const mode = env.KANBAN_AUTH || "access";
	if (mode === "off") {
		const exposed = hosts.find((host) => !isLoopback(host));
		if (exposed !== undefined) {
			throw new Error(
				`KANBAN_AUTH=off is only allowed on a loopback host, not "${exposed}"`,
			);
		}
		return { mode: "off" };
	}
	if (mode !== "access") {
		throw new Error(`KANBAN_AUTH must be "access" or "off", got "${mode}"`);
	}
	const team = env.KANBAN_ACCESS_TEAM;
	const aud = env.KANBAN_ACCESS_AUD;
	if (!team || !aud) {
		throw new Error(
			"KANBAN_AUTH=access needs KANBAN_ACCESS_TEAM and KANBAN_ACCESS_AUD",
		);
	}
	if (!/^[a-z0-9-]+$/.test(team)) {
		throw new Error(`KANBAN_ACCESS_TEAM is not a team name: "${team}"`);
	}
	return { mode: "access", team, aud };
};

const parseOrigin = (raw: string): string => {
	const url = new URL(raw);
	if (url.origin !== raw.replace(/\/$/, "")) {
		throw new Error(`KANBAN_ORIGIN must be a bare origin, got "${raw}"`);
	}
	return url.origin;
};

const parseOrigins = (
	env: NodeJS.ProcessEnv,
	auth: AuthConfig,
	port: number,
): string[] => {
	const configured = env.KANBAN_ORIGIN ? [parseOrigin(env.KANBAN_ORIGIN)] : [];
	if (auth.mode === "access") {
		if (configured.length === 0) {
			throw new Error("KANBAN_AUTH=access needs KANBAN_ORIGIN");
		}
		return configured;
	}
	return [
		...configured,
		`http://127.0.0.1:${port}`,
		`http://localhost:${port}`,
	];
};

// Secrets stay out of the launchd plist (scripts/launchd-setup.ts drops
// them), so the server reads them from ~/.config/kanban/env itself when the
// environment doesn't carry them.
export const secretKeys = [
	"KANBAN_RUNNER_TOKEN",
	"KANBAN_PROJECTS_TOKEN",
] as const;

export const withFileSecrets = (
	env: NodeJS.ProcessEnv,
	fileEnv: Record<string, string>,
): NodeJS.ProcessEnv => {
	const merged = { ...env };
	for (const key of secretKeys) {
		if (!merged[key] && fileEnv[key]) merged[key] = fileEnv[key];
	}
	return merged;
};

const names = (raw: string | undefined): string[] =>
	(raw ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
	const port = parsePort(env.KANBAN_PORT);
	const hosts = parseHosts(env.KANBAN_HOST);
	const auth = parseAuth(env, hosts);
	return {
		port,
		host: hosts[0] as string,
		hosts,
		runnerToken: parseRunnerToken(env.KANBAN_RUNNER_TOKEN),
		runnerCap: parseRunnerCap(env.KANBAN_RUNNER_CAP),
		expectedRunners: names(env.KANBAN_RUNNERS),
		runnerAddresses: env.KANBAN_RUNNER_ADDRESSES,
		plainOnlyRunners: names(env.KANBAN_RUNNERS_PLAIN_ONLY),
		updateLastRunners: names(env.KANBAN_RUNNERS_UPDATE_LAST),
		auth,
		origins: parseOrigins(env, auth, port),
		claudeBin: env.CLAUDE_BIN || findClaude(env.PATH),
		cmuxBin:
			env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux",
		cswapBin: env.CSWAP_BIN || "cswap",
		cswapRoot: cswapRoot(process.platform, env),
		claudeHome: env.CLAUDE_HOME || join(homedir(), ".claude"),
		dist: env.KANBAN_DIST || join(repoRoot, "dist"),
		auditLog:
			env.KANBAN_AUDIT_LOG ||
			join(homedir(), "Library/Logs/kanban/audit.jsonl"),
		stateDir: env.KANBAN_STATE || defaultStateDir(port),
		projects: parseProjectsConfig(env),
	};
};
