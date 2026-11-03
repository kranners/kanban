// kanban-runner: lets the hub place Claude Code sessions on this machine.
//   node dist/runner.js --hub http://10.100.0.11:7420
// or, from a checkout with Node 24, node src/runner/main.ts. See
// src/runner/config.ts for every flag and environment variable.
import { readKanbanEnv } from "../shared/envFile.ts";
import { startRunnerClient } from "./client.ts";
import { parseRunnerConfig, type RunnerConfig, runnerUsage } from "./config.ts";
import { createSessionManager } from "./sessions.ts";
import { createUsageSampler } from "./usage.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(runnerUsage);
	process.exit(0);
}

let config: RunnerConfig;
try {
	config = parseRunnerConfig(args, process.env, readKanbanEnv());
} catch (error) {
	console.error(`kanban-runner: ${(error as Error).message}\n\n${runnerUsage}`);
	process.exit(2);
}

const sessions = createSessionManager({
	claude: { file: config.claudeBin, args: config.claudeArgs },
	paths: config.paths,
});
const client = startRunnerClient({
	config,
	sessions,
	sample: createUsageSampler(),
});
console.error(
	`kanban-runner: ${config.name} (cap ${config.cap}) reporting to ${config.hub}`,
);

let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	// Sessions are children of this process: stop them rather than leave them
	// running where the board can no longer see them.
	await sessions.stopAll();
	await client.stop();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
