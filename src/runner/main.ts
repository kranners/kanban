// kanban-runner: lets the hub place Claude Code sessions on this machine.
//   node dist/runner.js --hub http://10.100.0.11:7420
// or, from a checkout with Node 24, node src/runner/main.ts. See
// src/runner/config.ts for every flag and environment variable.

import { serve } from "../agent/mcp.ts";
import { cswapList, cswapRoot, parseAccounts } from "../server/accounts.ts";
import { readKanbanEnv } from "../shared/envFile.ts";
import { liveRunnerStates } from "../shared/runners.ts";
import { startRunnerClient } from "./client.ts";
import { parseRunnerConfig, type RunnerConfig, runnerUsage } from "./config.ts";
import {
	docServer,
	docsMcpFlag,
	runnerDocsArgs,
	runnerDocsCaller,
} from "./docsMcp.ts";
import { createSessionManager } from "./sessions.ts";
import {
	createSignalSampler,
	listCheckouts,
	servedFolders,
} from "./signals.ts";
import { createSelfUpdate, fileVersion } from "./update.ts";
import { createUsageSampler } from "./usage.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(runnerUsage);
	process.exit(0);
}

// Claude starts this file again as each session's doc tools: answer MCP on
// stdio and nothing else.
const docsMcp = args[0] === docsMcpFlag;

let config: RunnerConfig;
try {
	config = parseRunnerConfig(docsMcp ? [] : args, process.env, readKanbanEnv());
} catch (error) {
	console.error(`kanban-runner: ${(error as Error).message}\n\n${runnerUsage}`);
	process.exit(2);
}

if (docsMcp) {
	const session = process.env.CLAUDE_CODE_SESSION_ID;
	if (!session) {
		console.error("kanban-runner docs: CLAUDE_CODE_SESSION_ID is required");
		process.exit(1);
	}
	serve(runnerDocsCaller(config.hub, config.token, session), docServer);
} else {
	await run(config);
}

async function run(config: RunnerConfig) {
	const script = process.argv[1] ?? "";
	// cswap's own cache answers `cswap list --json`; with fewer than two accounts,
	// or no cswap, sessions run on the machine's default login as before.
	const listCswap = cswapList(config.cswapBin);
	const root = cswapRoot();
	const sessions = createSessionManager({
		claude: {
			file: config.claudeBin,
			args: [
				...runnerDocsArgs(process.execPath, script, config.hub),
				...config.claudeArgs,
			],
		},
		paths: config.paths,
		accounts:
			config.cswapBin === "off"
				? null
				: {
						cswap: config.cswapBin,
						list: async () =>
							(parseAccounts(await listCswap(), root) ?? []).map(
								({ fetchedAt: _, ...account }) => ({
									...account,
									samples: [],
									blocked: null,
								}),
							),
					},
	});
	// Only the bundle the hub serves updates itself, never a checkout's source.
	const current = script.endsWith("runner.js")
		? await fileVersion(script)
		: null;
	const update = current
		? createSelfUpdate({
				script,
				current,
				hub: config.hub,
				token: config.token,
				idle: () =>
					!sessions
						.list()
						.some((session) => liveRunnerStates.includes(session.state)),
				exit: () => shutdown(),
			})
		: null;
	const client = startRunnerClient({
		config,
		sessions,
		sample: createUsageSampler(),
		signals: createSignalSampler({
			checkouts: () => listCheckouts(servedFolders(config.paths)),
		}),
		onVersion: (version) => update?.offer(version),
	});
	console.error(
		`kanban-runner: ${config.name} (cap ${config.cap}) reporting to ${config.hub}`,
	);

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		update?.stop();
		// Sessions are children of this process: stop them rather than leave them
		// running where the board can no longer see them.
		await sessions.stopAll();
		await client.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
