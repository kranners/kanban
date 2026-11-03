// The runner's command line and environment. Flags win over the environment,
// which wins over ~/.config/kanban/env (%USERPROFILE%\.config\kanban\env on
// Windows), so the token can live in that file instead of on a command line
// anyone can read in the process list.
import { hostname } from "node:os";
import { parseArgs } from "node:util";

export type RunnerConfig = {
	hub: string;
	token: string;
	name: string;
	cap: number;
	claudeBin: string;
	claudeArgs: string[];
	paths: [string, string][];
};

export const runnerUsage = `Usage: node dist/runner.js --hub URL [options]

  --hub URL        The hub, e.g. http://10.100.0.11:7420   (KANBAN_RUNNER_HUB)
  --token TOKEN    Shared bearer token                       (KANBAN_RUNNER_TOKEN)
  --name NAME      How the board names this machine          (KANBAN_RUNNER_NAME, default: hostname)
  --cap N          Most Claude sessions at once, 1-64        (KANBAN_RUNNER_CAP, default 4)
  --claude PATH    The claude binary                         (CLAUDE_BIN, default: claude on PATH)
  --claude-args A  Extra claude flags, space-separated       (KANBAN_RUNNER_CLAUDE_ARGS)
  --paths MAP      Hub-to-local folders, "from=to;from=to"   (KANBAN_RUNNER_PATHS)

Settings not given as flags or in the environment are read from
~/.config/kanban/env. Prefer KANBAN_RUNNER_TOKEN there (mode 600) to --token.`;

const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;

export const parsePaths = (raw: string): [string, string][] =>
	raw
		.split(";")
		.map((pair) => pair.trim())
		.filter((pair) => pair !== "")
		.map((pair) => {
			const eq = pair.indexOf("=");
			const from = pair.slice(0, eq).trim();
			const to = pair.slice(eq + 1).trim();
			if (eq <= 0 || !from || !to) {
				throw new Error(
					`KANBAN_RUNNER_PATHS wants from=to pairs, got "${pair}"`,
				);
			}
			return [from, to];
		});

export const parseRunnerConfig = (
	argv: string[],
	env: NodeJS.ProcessEnv,
	fileEnv: Record<string, string>,
	host: string = hostname(),
): RunnerConfig => {
	const { values } = parseArgs({
		args: argv,
		options: {
			hub: { type: "string" },
			token: { type: "string" },
			name: { type: "string" },
			cap: { type: "string" },
			claude: { type: "string" },
			"claude-args": { type: "string" },
			paths: { type: "string" },
		},
		strict: true,
	});
	const pick = (flag: string | undefined, key: string): string | undefined =>
		flag || env[key] || fileEnv[key] || undefined;
	const hubRaw = pick(values.hub, "KANBAN_RUNNER_HUB");
	if (!hubRaw) throw new Error("Give the hub with --hub or KANBAN_RUNNER_HUB");
	let hub: URL;
	try {
		hub = new URL(hubRaw);
	} catch {
		throw new Error(`--hub must be a URL, got "${hubRaw}"`);
	}
	if (hub.protocol !== "http:" && hub.protocol !== "https:") {
		throw new Error(`--hub must be http or https, got "${hubRaw}"`);
	}
	const token = pick(values.token, "KANBAN_RUNNER_TOKEN");
	if (!token) {
		throw new Error("Give the token with KANBAN_RUNNER_TOKEN or --token");
	}
	if (!tokenPattern.test(token)) {
		throw new Error(
			"The runner token must be 32-128 characters of A-Z, a-z, 0-9, _ or -",
		);
	}
	const capRaw = pick(values.cap, "KANBAN_RUNNER_CAP") ?? "4";
	const cap = Number(capRaw);
	if (!Number.isInteger(cap) || cap < 1 || cap > 64) {
		throw new Error(`--cap must be 1-64, got "${capRaw}"`);
	}
	const name = (pick(values.name, "KANBAN_RUNNER_NAME") ?? host)
		.trim()
		.slice(0, 60);
	return {
		hub: hub.origin + hub.pathname.replace(/\/+$/, ""),
		token,
		name: name || "runner",
		cap,
		claudeBin: pick(values.claude, "CLAUDE_BIN") ?? "claude",
		claudeArgs: (pick(values["claude-args"], "KANBAN_RUNNER_CLAUDE_ARGS") ?? "")
			.split(/\s+/)
			.filter((arg) => arg !== ""),
		paths: parsePaths(pick(values.paths, "KANBAN_RUNNER_PATHS") ?? ""),
	};
};
