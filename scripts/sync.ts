// Bring the checkout this script lives in up to date with origin/main:
// install changed dependencies off to the side, fast-forward, build, and
// restart the launchd `kanban` agent when server code changed, then confirm
// it answers /healthz. Safe to run unattended;
// the `kanban-sync` agent runs it every minute.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kanbanEnvPath, readKanbanEnv } from "./env-file.ts";

export type SyncFacts = {
	branch: string;
	dirty: boolean;
	headIsAncestor: boolean;
	headSha: string;
	originSha: string;
	stampSha: string | null;
	failedSha: string | null;
	disabled: boolean;
};

export type SyncPlan = `skip:${string}` | `refuse:${string}` | "update";

export const planSync = (facts: SyncFacts): SyncPlan => {
	if (facts.disabled) return "skip:disabled";
	if (facts.branch !== "main")
		return `refuse:on ${facts.branch || "a detached HEAD"}, not main`;
	if (facts.dirty) return "refuse:tracked files have uncommitted changes";
	if (!facts.headIsAncestor)
		return "refuse:local commits not on origin/main; run `npm run land` there";
	if (facts.failedSha === facts.originSha)
		return `skip:build failed for ${short(facts.originSha)}; waiting for a new push`;
	if (facts.headSha === facts.originSha && facts.stampSha === facts.headSha)
		return "skip:up to date";
	return "update";
};

const depFiles = new Set(["package.json", "package-lock.json"]);

export const needsDeps = (changed: readonly string[]): boolean =>
	changed.some((file) => depFiles.has(file));

// The server imports src/web/*.ts (board tools, reports, sticker
// validation), so only components, styles and assets there are page-only.
const pageAsset = /\.(?:tsx|css|html|svg|png|jpe?g|gif|webp|ico|woff2?)$/;

const pageOnly = (file: string): boolean =>
	(file.startsWith("src/web/") && pageAsset.test(file)) ||
	file.startsWith("docs/") ||
	file.startsWith("site/") ||
	file.startsWith(".github/") ||
	file.endsWith(".md");

export const needsRestart = (changed: readonly string[]): boolean =>
	needsDeps(changed) || changed.some((file) => !pageOnly(file));

export const lockStaleMs = 15 * 60_000;

export const isLockStale = (lock: {
	pidAlive: boolean;
	ageMs: number;
}): boolean => !lock.pidAlive || lock.ageMs > lockStaleMs;

const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : "none");

type Run = SpawnSyncReturns<string>;

const run = (cmd: string, args: string[], cwd: string): Run =>
	spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		maxBuffer: 64 * 1024 * 1024,
	});

const out = (result: Run): string => (result.stdout ?? "").trim();

const tail = (result: Run, lines = 20): string =>
	`${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`
		.trim()
		.split("\n")
		.slice(-lines)
		.join("\n");

const log = (line: string): void => {
	console.log(`${new Date().toISOString()} ${line}`);
};

type State = { notified?: string; failedSha?: string; syncedSha?: string };

const readState = (file: string): State => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as State;
	} catch {
		return {};
	}
};

const notify = (message: string): void => {
	if (process.platform !== "darwin") return;
	const text = message.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	spawnSync("osascript", [
		"-e",
		`display notification "${text}" with title "kanban"`,
	]);
};

const pidAlive = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const tryLock = (dir: string): boolean => {
	try {
		mkdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let ageMs = 0;
		let pid = Number.NaN;
		try {
			ageMs = Date.now() - statSync(dir).mtimeMs;
			pid = Number(readFileSync(join(dir, "pid"), "utf8"));
		} catch {}
		// A lock without a pid yet is being taken right now.
		const alive = Number.isNaN(pid) ? ageMs < 60_000 : pidAlive(pid);
		if (!isLockStale({ pidAlive: alive, ageMs })) return false;
		rmSync(dir, { recursive: true, force: true });
		try {
			mkdirSync(dir);
		} catch {
			return false;
		}
	}
	writeFileSync(join(dir, "pid"), String(process.pid));
	return true;
};

const lock = async (dir: string, waitMs: number): Promise<boolean> => {
	const until = Date.now() + waitMs;
	while (!tryLock(dir)) {
		if (Date.now() >= until) return false;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	return true;
};

// Is the launchd `kanban` agent loaded and serving this checkout?
const agentServes = (root: string): boolean => {
	if (process.platform !== "darwin") return false;
	const uid = process.getuid?.() ?? 0;
	const print = run("launchctl", ["print", `gui/${uid}/kanban`], root);
	return print.status === 0 && out(print).includes(root.replace(/\/$/, ""));
};

const restartServer = (root: string): boolean => {
	const uid = process.getuid?.() ?? 0;
	return (
		run("launchctl", ["kickstart", "-k", `gui/${uid}/kanban`], root).status ===
		0
	);
};

export const healthzUrl = (env: Record<string, string | undefined>): string => {
	const host = env.KANBAN_HOST || "127.0.0.1";
	const local = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	const name = local.includes(":") ? `[${local}]` : local;
	return `http://${name}:${env.KANBAN_PORT || "7420"}/healthz`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// After a restart, wait for the new server to answer. A server that crashes
// on start (a missing import, a broken dependency) never does.
const serverHealthy = async (
	url: string,
	waitMs = 30_000,
): Promise<boolean> => {
	const until = Date.now() + waitMs;
	await sleep(1000);
	while (Date.now() < until) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return true;
		} catch {}
		await sleep(1000);
	}
	return false;
};

// Install dependencies for `sha` into a directory beside the checkout, so a
// failed `npm ci` (offline, registry error) leaves the live node_modules alone.
const stageDeps = (root: string, common: string, sha: string): Run => {
	const dir = join(common, "kanban-deps");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir);
	for (const file of depFiles) {
		const show = run("git", ["show", `${sha}:${file}`], root);
		if (show.status !== 0) return show;
		writeFileSync(join(dir, file), show.stdout);
	}
	const install = run("npm", ["ci"], dir);
	if (install.status !== 0) rmSync(dir, { recursive: true, force: true });
	// A package without dependencies gets no node_modules.
	else mkdirSync(join(dir, "node_modules"), { recursive: true });
	return install;
};

const swapDeps = (root: string, common: string): void => {
	const live = join(root, "node_modules");
	const old = join(root, "node_modules.old");
	rmSync(old, { recursive: true, force: true });
	if (existsSync(live)) renameSync(live, old);
	renameSync(join(common, "kanban-deps", "node_modules"), live);
	rmSync(old, { recursive: true, force: true });
	rmSync(join(common, "kanban-deps"), { recursive: true, force: true });
};

export const sync = async (now: boolean): Promise<number> => {
	const verbose = now || process.stdout.isTTY === true;
	const here = fileURLToPath(new URL("..", import.meta.url));
	const disabled =
		process.env.KANBAN_SYNC === "off" ||
		readKanbanEnv(kanbanEnvPath()).KANBAN_SYNC === "off";
	if (disabled) {
		if (verbose) log("skipped: disabled (KANBAN_SYNC=off)");
		return 0;
	}
	const root = out(run("git", ["rev-parse", "--show-toplevel"], here));
	const common = out(
		run(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			here,
		),
	);
	if (!root || !common) {
		log("error: not in a git checkout");
		return 1;
	}
	const lockDir = join(common, "kanban-sync.lock");
	if (!(await lock(lockDir, now ? 120_000 : 0))) {
		if (verbose) log("skipped: another sync holds the lock");
		return now ? 1 : 0;
	}
	try {
		return await syncLocked(root, common, now, verbose);
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
};

const syncLocked = async (
	root: string,
	common: string,
	now: boolean,
	verbose: boolean,
): Promise<number> => {
	const stateFile = join(common, "kanban-sync.json");
	const state = readState(stateFile);
	const save = () => writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
	const once = (key: string, message: string) => {
		if (state.notified === key) return;
		notify(message);
		state.notified = key;
		save();
	};
	const git = (...args: string[]) => run("git", args, root);

	const fetch = git("fetch", "--quiet", "origin", "main");
	if (fetch.status !== 0) {
		// Offline is common on a laptop: log and notify once, not every minute.
		const key = `fetch:${out(git("rev-parse", "origin/main"))}`;
		if (verbose || state.notified !== key)
			log(`error: git fetch failed\n${tail(fetch)}`);
		once(key, "sync can't fetch origin");
		return 1;
	}
	const stampFile = join(root, "dist", ".commit");
	const readStamp = (): string | null => {
		if (!existsSync(join(root, "dist", "app.js"))) return null;
		try {
			return readFileSync(stampFile, "utf8").trim() || null;
		} catch {
			return null;
		}
	};
	const headSha = out(git("rev-parse", "HEAD"));
	const originSha = out(git("rev-parse", "origin/main"));
	const facts: SyncFacts = {
		branch: out(git("symbolic-ref", "--short", "-q", "HEAD")),
		dirty: out(git("status", "--porcelain", "--untracked-files=no")) !== "",
		headIsAncestor:
			git("merge-base", "--is-ancestor", "HEAD", "origin/main").status === 0,
		headSha,
		originSha,
		stampSha: readStamp(),
		// A run by hand, or from `npm run land`, retries a failed build.
		failedSha: verbose ? null : (state.failedSha ?? null),
		disabled: false,
	};
	const plan = planSync(facts);
	if (plan.startsWith("skip:")) {
		if (verbose) log(`skipped: ${plan.slice(5)}`);
		return 0;
	}
	const refuse = (reason: string): number => {
		const key = `refuse:${originSha}:${reason}`;
		if (verbose || state.notified !== key) log(`refused: ${reason}`);
		once(key, `Board not updated: ${reason}`);
		return 3;
	};
	if (plan.startsWith("refuse:")) return refuse(plan.slice(7));

	const head = originSha;
	const base = facts.stampSha ?? state.syncedSha ?? null;
	const diff = base ? git("diff", "--name-only", base, head) : null;
	const changed =
		diff && diff.status === 0 ? out(diff).split("\n").filter(Boolean) : null;
	const deps = changed
		? needsDeps(changed)
		: !existsSync(join(root, "node_modules", ".package-lock.json"));
	const fail = (what: string, result: Run, unchanged: string): number => {
		state.failedSha = head;
		save();
		log(`error: ${what} failed at ${short(head)}\n${tail(result)}`);
		once(`fail:${head}`, `${what} failed at ${short(head)}; ${unchanged}`);
		return 1;
	};
	// Install first, beside the checkout: if it fails nothing has moved.
	if (deps) {
		const install = stageDeps(root, common, head);
		if (install.status !== 0)
			return fail("npm ci", install, "checkout and board unchanged");
	}
	if (headSha !== originSha) {
		const merge = git("merge", "--ff-only", "--quiet", "origin/main");
		if (merge.status !== 0)
			return refuse(`fast-forward failed: ${tail(merge, 3)}`);
	}
	if (deps) swapDeps(root, common);
	const build = run("npm", ["run", "build"], root);
	if (build.status !== 0) return fail("build", build, "board unchanged");
	writeFileSync(stampFile, `${head}\n`);

	let restart = "no";
	if (changed === null || needsRestart(changed)) {
		if (!agentServes(root)) restart = "no-agent";
		else if (!restartServer(root)) restart = "failed";
		else {
			// The agent's environment is ~/.config/kanban/env, not ours.
			const url = healthzUrl(readKanbanEnv(kanbanEnvPath()));
			restart = (await serverHealthy(url)) ? "yes" : "unhealthy";
		}
	}
	state.failedSha = undefined;
	state.syncedSha = head;
	save();
	log(
		`synced ${short(base)}..${short(head)} deps=${deps ? "yes" : "no"} build=ok restart=${restart}`,
	);
	if (restart === "unhealthy") {
		log(
			`error: server did not answer after restart at ${short(head)}; see ~/Library/Logs/kanban/server.log`,
		);
		once(`down:${head}`, `Server down after ${short(head)}; see server.log`);
		return 1;
	}
	if (now && restart === "failed") return 1;
	return 0;
};

if (import.meta.main) {
	process.exitCode = await sync(process.argv.includes("--now"));
}
