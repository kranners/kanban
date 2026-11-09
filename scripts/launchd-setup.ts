// Install the launchd user agents that keep the board running on the Mac:
// `kanban` (the server) and `kanban-tunnel` (cloudflared). Idempotent;
// `--uninstall` removes them, and the retired `kanban-sync` updater too.
// `--runner` instead installs only `kanban-runner`, the agent that lets another
// Mac take sessions from the hub (see src/runner/main.ts).
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { kanbanEnvPath, readKanbanEnv } from "./env-file.ts";

export type PlistOptions = {
	label: string;
	programArguments: string[];
	workingDirectory?: string;
	environment?: Record<string, string>;
	keepAlive?: boolean;
	runAtLoad?: boolean;
	startInterval?: number;
	log: string;
};

const escapeXml = (text: string): string =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

const str = (text: string): string => `<string>${escapeXml(text)}</string>`;

export const renderPlist = (opts: PlistOptions): string => {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		`\t<key>Label</key>${str(opts.label)}`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...opts.programArguments.map((arg) => `\t\t${str(arg)}`),
		"\t</array>",
	];
	if (opts.workingDirectory)
		lines.push(`\t<key>WorkingDirectory</key>${str(opts.workingDirectory)}`);
	const env = Object.entries(opts.environment ?? {});
	if (env.length > 0) {
		lines.push("\t<key>EnvironmentVariables</key>", "\t<dict>");
		for (const [key, value] of env)
			lines.push(`\t\t<key>${escapeXml(key)}</key>${str(value)}`);
		lines.push("\t</dict>");
	}
	if (opts.keepAlive !== undefined)
		lines.push(`\t<key>KeepAlive</key><${opts.keepAlive}/>`);
	if (opts.runAtLoad !== undefined)
		lines.push(`\t<key>RunAtLoad</key><${opts.runAtLoad}/>`);
	if (opts.startInterval !== undefined)
		lines.push(
			`\t<key>StartInterval</key><integer>${Math.round(opts.startInterval)}</integer>`,
		);
	lines.push(
		`\t<key>StandardOutPath</key>${str(opts.log)}`,
		`\t<key>StandardErrorPath</key>${str(opts.log)}`,
		"</dict>",
		"</plist>",
		"",
	);
	return lines.join("\n");
};

export const buildPath = (
	dirs: readonly (string | null | undefined)[],
): string => {
	const seen = new Set<string>();
	for (const dir of dirs.flatMap((entry) => (entry ?? "").split(":")))
		if (dir) seen.add(dir);
	return [...seen].join(":");
};

// Plists sit world-readable in ~/Library/LaunchAgents, so secrets never go
// into them: the server and the runner read those from ~/.config/kanban/env.
export const secretKeys = [
	"KANBAN_RUNNER_TOKEN",
	"KANBAN_PROJECTS_TOKEN",
] as const;

export const withoutSecrets = (
	env: Record<string, string>,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(env).filter(
			([key]) => !(secretKeys as readonly string[]).includes(key),
		),
	);

// True when a file holding secrets can be read by anyone but its owner.
export const looseMode = (mode: number): boolean => (mode & 0o077) !== 0;

export const runnerPlist = (opts: {
	node: string;
	root: string;
	path: string;
	logs: string;
}): PlistOptions => ({
	label: "kanban-runner",
	programArguments: [opts.node, join(opts.root, "src", "runner", "main.ts")],
	workingDirectory: opts.root,
	environment: { PATH: opts.path },
	keepAlive: true,
	runAtLoad: true,
	log: join(opts.logs, "runner.log"),
});

type Run = SpawnSyncReturns<string>;

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv): Run =>
	spawnSync(cmd, args, { encoding: "utf8", env: env ?? process.env });

const out = (result: Run): string => (result.stdout ?? "").trim();

const which = (name: string): string | null =>
	out(run("/bin/sh", ["-c", `command -v ${name}`])) || null;

const stop = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const labels = [
	"kanban",
	"kanban-tunnel",
	"kanban-sync",
	"kanban-runner",
] as const;

const bootstrap =
	(uid: number, plistFor: (label: string) => string) =>
	(opts: PlistOptions): void => {
		const file = plistFor(opts.label);
		const xml = renderPlist(opts);
		if (existsSync(file) && readFileSync(file, "utf8") !== xml) {
			copyFileSync(file, `${file}.bak`);
			console.log(`backed up ${file}.bak`);
		}
		writeFileSync(file, xml);
		run("launchctl", ["bootout", `gui/${uid}/${opts.label}`]);
		// bootout returns before the job is gone, so bootstrap may need a retry.
		let boot = run("launchctl", ["bootstrap", `gui/${uid}`, file]);
		for (let i = 0; i < 10 && boot.status !== 0; i++) {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
			boot = run("launchctl", ["bootstrap", `gui/${uid}`, file]);
		}
		if (boot.status !== 0)
			console.error(
				`launchctl bootstrap ${opts.label} failed: ${boot.stderr.trim()}`,
			);
		const state = out(run("launchctl", ["print", `gui/${uid}/${opts.label}`]))
			.split("\n")
			.filter((line) => /^\s*(state|pid|last exit code) =/.test(line))
			.map((line) => line.trim())
			.join(", ");
		console.log(`${opts.label}: ${state || "not loaded"}`);
	};

const warnLooseEnv = (file: string, env: Record<string, string>): void => {
	if (!secretKeys.some((key) => env[key])) return;
	try {
		if (looseMode(statSync(file).mode))
			console.warn(
				`${file} holds KANBAN_RUNNER_TOKEN but others can read it; run \`chmod 600 ${file}\`.`,
			);
	} catch {}
};

const installRunner = (): void => {
	if (process.platform !== "darwin") stop("launchd-setup runs on macOS only.");
	const uid = process.getuid?.() ?? 0;
	const home = homedir();
	const agents = join(home, "Library", "LaunchAgents");
	const logs = join(home, "Library", "Logs", "kanban");
	const root = out(run("git", ["rev-parse", "--show-toplevel"]));
	if (!root) stop("Run this from a kanban checkout.");
	const envFile = kanbanEnvPath(home);
	const fileEnv = readKanbanEnv(envFile);
	if (!fileEnv.KANBAN_RUNNER_HUB || !fileEnv.KANBAN_RUNNER_TOKEN)
		stop(
			`Set KANBAN_RUNNER_HUB (e.g. http://10.100.0.11:7420) and KANBAN_RUNNER_TOKEN in ${envFile} first.`,
		);
	warnLooseEnv(envFile, fileEnv);
	mkdirSync(agents, { recursive: true });
	mkdirSync(logs, { recursive: true });
	const node = which("node") ?? process.execPath;
	const claudeBin = fileEnv.CLAUDE_BIN ?? which("claude");
	const path = buildPath([
		dirname(node),
		claudeBin ? dirname(claudeBin) : null,
		"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
	]);
	bootstrap(uid, (label) => join(agents, `${label}.plist`))(
		runnerPlist({ node, root, path, logs }),
	);
	console.log(`Runner log: ${join(logs, "runner.log")}.`);
};

const install = (uninstall: boolean): void => {
	if (process.platform !== "darwin") stop("launchd-setup runs on macOS only.");
	const uid = process.getuid?.() ?? 0;
	const home = homedir();
	const agents = join(home, "Library", "LaunchAgents");
	const logs = join(home, "Library", "Logs", "kanban");
	const plistFor = (label: string) => join(agents, `${label}.plist`);

	if (uninstall) {
		for (const label of labels) {
			run("launchctl", ["bootout", `gui/${uid}/${label}`]);
			rmSync(plistFor(label), { force: true });
			console.log(`removed ${label}`);
		}
		return;
	}

	const root = out(run("git", ["rev-parse", "--show-toplevel"]));
	const common = out(
		run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
	);
	if (!root || root !== dirname(common))
		stop(
			"Run this from the main checkout, not a worktree: the live board serves the checkout the agents point at.",
		);
	if (out(run("git", ["symbolic-ref", "--short", "-q", "HEAD"])) !== "main")
		stop("The main checkout must be on `main`.");

	mkdirSync(agents, { recursive: true });
	mkdirSync(logs, { recursive: true });
	const fileEnv = readKanbanEnv(kanbanEnvPath(home));
	warnLooseEnv(kanbanEnvPath(home), fileEnv);
	const node = which("node") ?? process.execPath;
	const claudeBin =
		fileEnv.CLAUDE_BIN ?? process.env.CLAUDE_BIN ?? which("claude");
	if (!claudeBin)
		console.warn(
			"claude not found on PATH; set CLAUDE_BIN in ~/.config/kanban/env.",
		);
	const path = buildPath([
		dirname(node),
		claudeBin ? dirname(claudeBin) : null,
		"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
	]);

	const plists: PlistOptions[] = [
		{
			label: "kanban",
			programArguments: [node, join(root, "src", "server", "main.ts")],
			workingDirectory: root,
			environment: { ...withoutSecrets(fileEnv), PATH: path },
			keepAlive: true,
			runAtLoad: true,
			log: join(logs, "server.log"),
		},
	];
	const tokenFile = join(home, ".config", "kanban", "tunnel-token");
	const cloudflared = which("cloudflared");
	if (cloudflared && existsSync(tokenFile))
		plists.push({
			label: "kanban-tunnel",
			programArguments: [
				cloudflared,
				"tunnel",
				"run",
				"--token-file",
				tokenFile,
			],
			keepAlive: true,
			runAtLoad: true,
			log: join(logs, "tunnel.log"),
		});
	else
		console.log(
			"Skipping kanban-tunnel: needs cloudflared on PATH and ~/.config/kanban/tunnel-token (scripts/cloudflare-setup.ts writes it).",
		);

	for (const opts of plists) bootstrap(uid, plistFor)(opts);
	console.log(
		`Logs: ${logs}. Check for leftover agents with \`launchctl list | grep -i kanban\`.`,
	);
};

if (import.meta.main) {
	if (process.argv.includes("--runner")) installRunner();
	else install(process.argv.includes("--uninstall"));
}
