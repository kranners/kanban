import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export type AuthConfig =
	| { mode: "off" }
	| { mode: "access"; team: string; aud: string };

export type Config = {
	port: number;
	host: string;
	auth: AuthConfig;
	origins: string[];
	claudeBin: string;
	cmuxBin: string;
	claudeHome: string;
	dist: string;
	auditLog: string;
	stateDir: string;
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

const parseAuth = (env: NodeJS.ProcessEnv, host: string): AuthConfig => {
	const mode = env.KANBAN_AUTH || "access";
	if (mode === "off") {
		if (!isLoopback(host)) {
			throw new Error(
				`KANBAN_AUTH=off is only allowed on a loopback host, not "${host}"`,
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

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
	const port = parsePort(env.KANBAN_PORT);
	const host = env.KANBAN_HOST || "127.0.0.1";
	const auth = parseAuth(env, host);
	return {
		port,
		host,
		auth,
		origins: parseOrigins(env, auth, port),
		claudeBin: env.CLAUDE_BIN || findClaude(env.PATH),
		cmuxBin:
			env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux",
		claudeHome: env.CLAUDE_HOME || join(homedir(), ".claude"),
		dist: env.KANBAN_DIST || join(repoRoot, "dist"),
		auditLog:
			env.KANBAN_AUDIT_LOG ||
			join(homedir(), "Library/Logs/kanban/audit.jsonl"),
		stateDir: env.KANBAN_STATE || defaultStateDir(port),
	};
};
