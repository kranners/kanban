// Land HEAD on origin/main: fetch, rebase, `npm run check`, push HEAD:main,
// and retry when another session pushed first. On the Mac it then syncs the
// main checkout so the change is live. Never force-pushes, stashes or checks
// out main, so it works from a worktree, the main checkout or a cloud clone.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const attempts = 5;

// main moved under us: an ordinary rejection, or a push that lost the race
// to update the ref ("cannot lock ref", "incorrect old value provided").
export const isNonFastForward = (stderr: string): boolean =>
	/\((?:fetch first|non-fast-forward|stale info|incorrect old value provided)\)/.test(
		stderr,
	) ||
	/Updates were rejected because the (?:remote contains work|tip of)/.test(
		stderr,
	) ||
	/cannot lock ref 'refs\/heads\/main'/.test(stderr);

export const parseConflicts = (out: string): string[] =>
	out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

export const shouldSyncHere = (where: {
	platform: string;
	mainBranch: string;
}): boolean => where.platform === "darwin" && where.mainBranch === "main";

type Run = SpawnSyncReturns<string>;

const run = (
	cmd: string,
	args: string[],
	opts: { cwd?: string; inherit?: boolean } = {},
): Run =>
	spawnSync(cmd, args, {
		cwd: opts.cwd,
		encoding: "utf8",
		stdio: opts.inherit ? "inherit" : "pipe",
		maxBuffer: 64 * 1024 * 1024,
	});

const out = (result: Run): string => (result.stdout ?? "").trim();
const git = (...args: string[]) => run("git", args);

const stop = (message: string, code = 1): never => {
	console.error(message);
	process.exit(code);
};

const ahead = (): number =>
	Number(out(git("rev-list", "--count", "origin/main..HEAD")) || "0");

const fetchMain = (): void => {
	const fetch = run("git", ["fetch", "origin", "main"], { inherit: true });
	if (fetch.status !== 0) stop("git fetch origin main failed.");
};

const preflight = (): void => {
	if (out(git("status", "--porcelain", "--untracked-files=no")) !== "")
		stop("Tracked files have uncommitted changes. Commit them, then rerun.");
	// `npm run check` sees the working tree, so an untracked file a commit
	// imports would pass here and be missing on main.
	const untracked = out(git("ls-files", "--others", "--exclude-standard"));
	if (untracked !== "")
		stop(
			[
				"Untracked files would make `npm run check` test what main won't get:",
				...untracked.split("\n").map((file) => `  ${file}`),
				"Commit, delete or .gitignore them, then rerun.",
			].join("\n"),
		);
	const gitDir = out(git("rev-parse", "--absolute-git-dir"));
	if (
		existsSync(join(gitDir, "rebase-merge")) ||
		existsSync(join(gitDir, "rebase-apply"))
	)
		stop(
			"A rebase is in progress. Finish it (`git rebase --continue`) or abort it.",
		);
	if (existsSync(join(gitDir, "MERGE_HEAD")))
		stop("A merge is in progress. Finish or abort it first.");
};

const rebase = (): void => {
	const result = git("rebase", "origin/main");
	if (result.status === 0) return;
	const conflicts = parseConflicts(
		out(git("diff", "--name-only", "--diff-filter=U")),
	);
	git("rebase", "--abort");
	stop(
		[
			"Rebase onto origin/main conflicts; nothing was pushed.",
			...conflicts.map((file) => `  ${file}`),
			"The rebase was aborted. Run `git rebase origin/main`, fix the files, `git add` them,",
			"`git rebase --continue`, then rerun `npm run land`.",
		].join("\n"),
	);
};

const pushMain = (): "ok" | "retry" => {
	const push = git("push", "origin", "HEAD:main");
	process.stderr.write(push.stderr ?? "");
	if (push.status === 0) return "ok";
	if (isNonFastForward(push.stderr ?? "")) return "retry";
	return stop("git push failed.");
};

const makeLive = (): void => {
	const common = out(
		git("rev-parse", "--path-format=absolute", "--git-common-dir"),
	);
	const main = dirname(common);
	const mainBranch = out(
		run("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: main }),
	);
	if (!shouldSyncHere({ platform: process.platform, mainBranch })) {
		console.log(
			"On main. Not live yet: the Mac's kanban-sync agent fast-forwards, builds and restarts within a minute. Say so in your final message.",
		);
		return;
	}
	const uid = process.getuid?.() ?? 0;
	if (run("launchctl", ["print", `gui/${uid}/kanban-sync`]).status !== 0)
		console.error(
			"Automatic pickup not installed: run `npm run launchd-setup` in the main checkout.",
		);
	const script = join(main, "scripts", "sync.ts");
	if (!existsSync(script))
		stop(
			`landed but NOT live: ${main} has no scripts/sync.ts yet; run \`git pull --ff-only && npm ci && npm run launchd-setup\` there.`,
			2,
		);
	const sync = run(process.execPath, [script, "--now"], { cwd: main });
	const output = `${sync.stdout ?? ""}${sync.stderr ?? ""}`.trim();
	if (output) console.log(output);
	if (sync.status !== 0) {
		const lines = output.split("\n");
		const reason =
			lines
				.find((line) => / refused: /.test(line))
				?.replace(/^.* refused: /, "") ??
			lines.at(-1) ??
			`sync exited ${sync.status}`;
		stop(`landed but NOT live: ${reason}`, 2);
	}
	console.log("Live. Check the change on the board.");
};

export const land = (dryRun: boolean): void => {
	preflight();
	fetchMain();
	if (ahead() === 0)
		stop("Nothing to land: HEAD has no commits that origin/main lacks.");
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (attempt > 1) fetchMain();
		rebase();
		if (ahead() === 0)
			stop("Nothing to land: origin/main already has these commits.");
		const check = run("npm", ["run", "check"], { inherit: true });
		if (check.status !== 0) stop("npm run check failed; nothing was pushed.");
		const sha = out(git("rev-parse", "HEAD"));
		if (dryRun) {
			console.log(`Dry run: would push ${sha} to origin/main.`);
			return;
		}
		if (pushMain() === "retry") {
			console.error("main moved; rebasing and checking again.");
			continue;
		}
		console.log(`landed ${sha} on origin/main`);
		makeLive();
		return;
	}
	stop(`main is busy; rerun. (${attempts} pushes were rejected.)`);
};

if (import.meta.main) {
	land(process.argv.includes("--dry-run"));
}
