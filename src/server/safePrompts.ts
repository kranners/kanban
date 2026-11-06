import { tmpdir } from "node:os";
import { basename, isAbsolute, normalize, resolve, sep } from "node:path";

// Which permission prompts the board may approve without Aaron: tools that
// only read, organise a session's own work or reach claude.ai's own session
// tools, and shell commands made only of reads, builds, tests and git work on
// a branch of the session's own clone. Everything else, and anything the
// guardrails below name (pushing to main, force pushes, deletes outside the
// folder, deploys, cloud and cluster changes, secrets, sends and payments),
// stays a prompt for Aaron, with the reason it was left.

export type SafeVerdict = { safe: true } | { safe: false; reason: string };

const safe: SafeVerdict = { safe: true };
const unsafe = (reason: string): SafeVerdict => ({ safe: false, reason });
const notInSafeSet = "not in the safe set";

const remotePrefix = "mcp__claude-code-remote__";

/** claude.ai's session tools that change environments, credentials, computers, trust or other sessions' lives. */
const refusedRemote = new Set([
	"create_environment",
	"update_environment",
	"switch_environment",
	"request_credential",
	"request_computer_folder",
	"confirm_repository_trust",
	"archive_session",
	"unarchive_session",
	"interrupt_session",
]);

const refusedRemoteWords =
	/environment|credential|computer|trust|archive|interrupt/;

/**
 * The scheduled tasks a session keeps for its own check-ins. Which session a
 * task wakes depends on its input or on the task itself, so each prompt is
 * judged and approved alone, never granted for the rest of the session.
 */
const triggerTools = new Set([
	"create_trigger",
	"update_trigger",
	"delete_trigger",
	"fire_trigger",
]);

/** The claude.ai session tools granted for the rest of a session once a safe prompt of it is approved. */
const safeRemote = [
	"add_repo",
	"get_environment",
	"get_event",
	"get_session",
	"get_trigger",
	"list_computer_folders",
	"list_environments",
	"list_events",
	"list_repos",
	"list_sessions",
	"list_triggers",
	"create_trigger",
	"update_trigger",
	"delete_trigger",
	"fire_trigger",
	"create_session",
	"read_documentation",
	"register_repo_root",
	"report_preview_port",
	"send_later",
	"send_message",
	"set_session_tags",
	"set_session_title",
	"subscribe_pr_activity",
	"unsubscribe_pr_activity",
	"watch_url",
	"unwatch_url",
];

const safeRemoteSet = new Set(safeRemote);

/** Tools that are safe whatever their input. */
const inputFree = [
	"Workflow",
	"Task",
	"Agent",
	"Skill",
	"ToolSearch",
	"SendMessage",
	"Monitor",
	"EnterWorktree",
	"ExitWorktree",
	"WebFetch",
	"WebSearch",
	"TaskCreate",
	"TaskUpdate",
	"TaskList",
	"TaskGet",
	"TaskOutput",
	"TaskStop",
	"TodoWrite",
];

/**
 * The tool names a cloud session is granted for the rest of its life when
 * Aaron's safe set approves one of its prompts. Never Bash, Edit or Write:
 * whether those are safe depends on their input, so each is judged again.
 */
export const SAFE_SESSION_RULES: readonly string[] = [
	...inputFree,
	// A scheduled task may wake another session, so each is judged again every time.
	...safeRemote
		.filter((tool) => !triggerTools.has(tool))
		.map((tool) => `${remotePrefix}${tool}`),
];

const inputFreeSet = new Set(inputFree);
const fileWriters = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools that only read, safe unless they read a secret. */
const fileReaders = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);

// Paths

const tempRoots = [
	"/tmp",
	"/private/tmp",
	"/var/tmp",
	"/var/folders",
	"/private/var/folders",
	tmpdir(),
];

const systemRoots = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/boot",
	"/dev",
	"/lib",
	"/opt",
	"/proc",
	"/root",
	"/sys",
	"/var",
	"/System",
	"/Library",
	"/Applications",
	"/nix",
];

const under = (path: string, root: string) =>
	path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

const inTemp = (path: string) => tempRoots.some((root) => under(path, root));

/** Whether a path names a secret: env files, keys, credentials, cloud and ssh config, Claude's settings. */
export const secretPath = (path: string): boolean => {
	const parts = normalize(path).split(/[\\/]+/);
	const name = basename(path);
	return (
		/^\.env/i.test(name) ||
		/\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) ||
		/^id_/.test(name) ||
		/^\.?credentials/i.test(name) ||
		/^\.git-credentials$/i.test(name) ||
		name === "environ" ||
		/^secrets?/i.test(name) ||
		/^\.(netrc|pgpass|npmrc|pypirc)$/i.test(name) ||
		parts.some((part) =>
			[".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure"].includes(part),
		) ||
		parts.some(
			(part, at) =>
				part === "gh" &&
				parts[at - 1] === ".config" &&
				parts[at + 1] === "hosts.yml",
		) ||
		parts.some(
			(part, at) => part === ".config" && parts[at + 1] === "gcloud",
		) ||
		parts.some(
			(part, at) =>
				part === ".claude" && /^settings/i.test(parts[at + 1] ?? ""),
		)
	);
};

/** A secret-named file, by the looser test that reading or printing one uses. */
const secretRead = (path: string): boolean =>
	secretPath(path) ||
	/secret|credential|(^|[._-])tokens?([._-]|$)/i.test(basename(path));

const gitInternal = (path: string): boolean =>
	normalize(path)
		.split(/[\\/]+/)
		.includes(".git");

const homeRelative = (path: string) =>
	path === "~" || path.startsWith("~/") || /^\$\{?HOME\b/.test(path);

const tempVariable = (path: string) =>
	/^\$\{?TMPDIR\}?(\/|$)/.test(path) && !path.split("/").includes("..");

/**
 * Where a shell command stands: the session's folder when the board knows
 * it, and the directory a cd moved to, null once that cannot be read.
 */
type Place = { root?: string; dir?: string | null };

/**
 * Whether a file may be written: inside the session's folder or a temp
 * directory when the folder is known, and otherwise anywhere that is not a
 * home dotfile or a system directory.
 */
const writable = (path: string, place: Place): boolean => {
	if (tempVariable(path)) return true;
	if (homeRelative(path) || path.includes("$")) return false;
	const climbs = path.split(/[\\/]+/).includes("..");
	if (!isAbsolute(path) && place.dir === null) return false;
	if (climbs && place.dir !== undefined) return false;
	const base = place.dir ?? place.root;
	if (base === undefined && !isAbsolute(path)) return !climbs;
	const full = base === undefined ? normalize(path) : resolve(base, path);
	if (place.root) return under(full, resolve(place.root)) || inTemp(full);
	return inTemp(full) || !systemRoots.some((root) => under(full, root));
};

const fileVerdict = (path: unknown, place: Place): SafeVerdict => {
	if (typeof path !== "string" || path === "") {
		return unsafe("names no file");
	}
	if (secretPath(path)) return unsafe(`writes a secret-like file ${path}`);
	if (gitInternal(path)) return unsafe(`writes git's own files in ${path}`);
	return writable(path, place)
		? safe
		: unsafe(`writes ${path}, outside the session's folder`);
};

// Tools other than Bash

const githubReads = /^(get_|list_|search_)|_read$/;
const githubWrites = new Set([
	"create_pull_request",
	"add_issue_comment",
	"pull_request_review_write",
	"add_comment_to_pending_review",
]);
const githubBranchWrites = new Set([
	"create_branch",
	"push_files",
	"create_or_update_file",
]);

const mainBranch = (branch: string) =>
	/^(refs\/)?(heads\/)?(main|master)$/.test(branch);

/**
 * The work review tooling's names, from KANBAN_REVIEW_TOOLS, comma
 * separated: MCP servers whose name holds one and commands that start with
 * one. Kept out of the repository, which is public.
 */
const reviewTools = (): string[] =>
	(process.env.KANBAN_REVIEW_TOOLS ?? "")
		.split(",")
		.map((name) => name.trim().toLowerCase())
		.filter((name) => /^[a-z0-9][a-z0-9_-]*$/.test(name));

const mcpVerdict = (
	toolName: string,
	input: Record<string, unknown>,
): SafeVerdict => {
	const [, server = "", ...rest] = toolName.split("__");
	const tool = rest.join("__");
	if (reviewTools().some((name) => server.toLowerCase().includes(name))) {
		return /merge|deploy|delete|destroy/i.test(tool)
			? unsafe("merges, deploys or deletes")
			: safe;
	}
	if (/github/i.test(server)) {
		if (githubReads.test(tool) || githubWrites.has(tool)) return safe;
		if (githubBranchWrites.has(tool)) {
			const branch = input.branch;
			if (typeof branch !== "string" || branch === "") {
				return unsafe("names no branch, so it may write the default branch");
			}
			return mainBranch(branch) ? unsafe(`writes to ${branch}`) : safe;
		}
		return unsafe(notInSafeSet);
	}
	return unsafe(notInSafeSet);
};

const remoteServer = "claude-code-remote";

/** A display label's words, "Send Message", as the tool name it shows, send_message. */
const snake = (label: string) =>
	label
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");

/** A label, "Approve or deny claude-code-remote — Send Message", as its server and the tool's words. */
const labelParts = (text: string) => {
	const parts = text
		.trim()
		.replace(/^Approve or deny\s+/, "")
		.split(/\s+[—–-]\s+/);
	return parts.length === 2
		? { server: parts[0]?.trim(), shown: parts[1]?.trim() ?? "" }
		: undefined;
};

/**
 * The tool a prompt is for, from its tool name and the label claude.ai shows
 * for it, such as "Approve or deny claude-code-remote — Send Message" for
 * mcp__claude-code-remote__send_message. Only claude.ai's own server, by its
 * exact name, is ever read from a label, and only where the prompt gives the
 * label as its name or the label agrees with a bare tool name, so a label
 * never makes another tool look like one of the safe set's. A label naming no
 * server names no tool.
 */
export const promptTool = (toolName: string, title?: string): string => {
	const name = toolName.trim();
	const named = /^claude-code-remote(?:__|:)([a-z][a-z0-9_]*)$/.exec(name);
	if (named?.[1]) return `${remotePrefix}${named[1]}`;
	if (/\s/.test(name)) {
		const label = labelParts(name);
		return label?.server === remoteServer && label.shown
			? `${remotePrefix}${snake(label.shown)}`
			: name;
	}
	if (title && /^[a-z][a-z0-9_]*$/.test(name)) {
		const label = labelParts(title);
		if (label?.server === remoteServer && snake(label.shown) === name) {
			return `${remotePrefix}${name}`;
		}
	}
	return name;
};

/** safeVerdict for a prompt as the board lists it, by its tool name and its label. */
export const promptVerdict = (
	toolName: string,
	title: string | undefined,
	input: Record<string, unknown>,
	cwd?: string,
): SafeVerdict => safeVerdict(promptTool(toolName, title), input, cwd);

/**
 * Whether the board may approve a permission prompt for this tool and input
 * without Aaron. cwd is the session's own folder when the board knows it.
 */
export const safeVerdict = (
	toolName: string,
	input: Record<string, unknown>,
	cwd?: string,
): SafeVerdict => {
	if (toolName.startsWith(remotePrefix)) {
		const tool = toolName.slice(remotePrefix.length);
		const reads = /^(get|list|read)_/.test(tool);
		if (refusedRemote.has(tool) || (!reads && refusedRemoteWords.test(tool))) {
			return unsafe(
				"changes environments, credentials, computers, trust or another session",
			);
		}
		if (triggerTools.has(tool)) {
			const bound = input.persistent_session_id;
			if (bound !== undefined && bound !== null && bound !== "") {
				return unsafe("schedules a wake of another session");
			}
			const spawns = input.create_new_session_on_fire;
			if (spawns !== undefined && spawns !== null && spawns !== false) {
				return unsafe("starts a new session on every firing");
			}
		}
		return safeRemoteSet.has(tool) || reads ? safe : unsafe(notInSafeSet);
	}
	if (inputFreeSet.has(toolName) || /^(Task|Todo)[A-Z]\w*$/.test(toolName)) {
		return safe;
	}
	if (fileReaders.has(toolName)) {
		const path = input.file_path ?? input.notebook_path;
		if (toolName === "Read" || toolName === "NotebookRead") {
			if (typeof path !== "string" || path === "") {
				return unsafe("names no file");
			}
		}
		for (const value of [input.file_path, input.notebook_path, input.path]) {
			if (typeof value === "string" && secretRead(value)) {
				return unsafe(`reads a secret-like file ${value}`);
			}
		}
		if (
			typeof input.pattern === "string" &&
			toolName === "Glob" &&
			secretRead(input.pattern)
		) {
			return unsafe(`reads a secret-like file ${input.pattern}`);
		}
		if (typeof input.glob === "string" && secretRead(input.glob)) {
			return unsafe(`reads a secret-like file ${input.glob}`);
		}
		return safe;
	}
	if (fileWriters.has(toolName)) {
		return fileVerdict(input.file_path ?? input.notebook_path, {
			...(cwd ? { root: cwd } : {}),
		});
	}
	if (toolName === "Bash") {
		const command = input.command;
		return typeof command === "string" && command.trim() !== ""
			? bashVerdict(command, cwd)
			: unsafe("runs no command");
	}
	if (toolName.startsWith("mcp__")) return mcpVerdict(toolName, input);
	return unsafe(notInSafeSet);
};

// Shell parsing: enough of bash to split a command into simple commands,
// with quotes, escapes, comments, heredocs and $(…) or `…` substitutions,
// whose commands are judged like any other.

type Word = { text: string; dynamic: boolean };
type Redirect = { op: string; target: Word };
type Segment = { words: Word[]; redirects: Redirect[] };

class ShellSyntax extends Error {}

const parseShell = (src: string): Segment[] => {
	const segments: Segment[] = [];
	let i = 0;
	let heredocs: { delimiter: string; strip: boolean }[] = [];

	const skipHeredocs = () => {
		for (const { delimiter, strip } of heredocs) {
			for (;;) {
				if (i >= src.length) break;
				const end = src.indexOf("\n", i);
				const line = src.slice(i, end === -1 ? src.length : end);
				i = end === -1 ? src.length : end + 1;
				if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
			}
		}
		heredocs = [];
	};

	const word = (): Word => {
		let text = "";
		let dynamic = false;
		const substitute = () => {
			commands(true);
			text += "$(…)";
			dynamic = true;
		};
		const backtick = () => {
			let end = i + 1;
			while (end < src.length && src[end] !== "`") {
				end += src[end] === "\\" ? 2 : 1;
			}
			if (end >= src.length) throw new ShellSyntax("an unclosed backtick");
			segments.push(...parseShell(src.slice(i + 1, end)));
			i = end + 1;
			text += "$(…)";
			dynamic = true;
		};
		const arithmetic = () => {
			const end = src.indexOf("))", i);
			if (end === -1) throw new ShellSyntax("an unclosed $((");
			i = end + 2;
			text += "0";
		};
		while (i < src.length) {
			const c = src[i] as string;
			if (" \t\n;&|()<>".includes(c)) break;
			if (c === "\\") {
				text += src[i + 1] ?? "";
				i += 2;
			} else if (c === "'") {
				const end = src.indexOf("'", i + 1);
				if (end === -1) throw new ShellSyntax("an unclosed quote");
				text += src.slice(i + 1, end);
				i = end + 1;
			} else if (c === '"') {
				i += 1;
				for (;;) {
					if (i >= src.length) throw new ShellSyntax("an unclosed quote");
					const d = src[i] as string;
					if (d === '"') {
						i += 1;
						break;
					}
					if (d === "\\" && '"\\$`\n'.includes(src[i + 1] ?? "")) {
						text += src[i + 1];
						i += 2;
					} else if (d === "$" && src.startsWith("$((", i)) arithmetic();
					else if (d === "$" && src[i + 1] === "(") {
						i += 2;
						substitute();
					} else if (d === "`") backtick();
					else {
						if (d === "$") dynamic = true;
						text += d;
						i += 1;
					}
				}
			} else if (c === "$" && src.startsWith("$((", i)) arithmetic();
			else if (c === "$" && src[i + 1] === "(") {
				i += 2;
				substitute();
			} else if (c === "`") backtick();
			else {
				if (c === "$") dynamic = true;
				text += c;
				i += 1;
			}
		}
		return { text, dynamic };
	};

	function commands(untilParen: boolean): void {
		let current: Segment = { words: [], redirects: [] };
		let depth = 0;
		let redirect: string | null = null;
		const flush = () => {
			if (redirect) throw new ShellSyntax("a redirect with no target");
			if (current.words.length > 0 || current.redirects.length > 0) {
				segments.push(current);
			}
			current = { words: [], redirects: [] };
		};
		while (i < src.length) {
			const c = src[i] as string;
			if (c === " " || c === "\t") {
				i += 1;
			} else if (c === "\\" && src[i + 1] === "\n") {
				i += 2;
			} else if (c === "#" && !redirect) {
				while (i < src.length && src[i] !== "\n") i += 1;
			} else if (c === "\n") {
				flush();
				i += 1;
				skipHeredocs();
			} else if (c === ")") {
				i += 1;
				flush();
				if (depth === 0) {
					if (untilParen) return;
					throw new ShellSyntax("an unmatched )");
				}
				depth -= 1;
			} else if (c === "(") {
				i += 1;
				flush();
				depth += 1;
			} else if (c === "&" && src[i + 1] === ">") {
				i += src[i + 2] === ">" ? 3 : 2;
				redirect = ">";
			} else if (";&|".includes(c)) {
				i += ";&|".includes(src[i + 1] ?? "x") ? 2 : 1;
				flush();
			} else if (c === "<" && src[i + 1] === "(") {
				i += 2;
				commands(true);
				current.words.push({ text: "$(…)", dynamic: true });
			} else if (c === "<" || c === ">") {
				let op = "";
				while (src[i] === "<" || src[i] === ">") op += src[i++];
				if (src[i] === "&") {
					i += 1;
					while (/[0-9-]/.test(src[i] ?? "")) i += 1;
					continue;
				}
				if (op === "<<" || op === "<<-") {
					while (src[i] === " " || src[i] === "\t") i += 1;
					heredocs.push({ delimiter: word().text, strip: op === "<<-" });
					continue;
				}
				redirect = op;
			} else {
				const next = word();
				if (redirect) {
					current.redirects.push({ op: redirect, target: next });
					redirect = null;
				} else if (/^[0-9]+$/.test(next.text) && /[<>]/.test(src[i] ?? "")) {
					// A file descriptor before a redirect.
				} else {
					current.words.push(next);
				}
			}
		}
		flush();
		if (untilParen) throw new ShellSyntax("an unclosed $(");
	}

	commands(false);
	return segments;
};

// Shell commands

const readCommands = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"find",
	"sed",
	"awk",
	"gawk",
	"jq",
	"yq",
	"diff",
	"stat",
	"file",
	"pwd",
	"echo",
	"printf",
	"which",
	"date",
	"sort",
	"uniq",
	"cut",
	"tr",
	"tree",
	"du",
	"df",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"true",
	"false",
	"test",
	"[",
	"sleep",
	"column",
	"nl",
	"comm",
	"cmp",
	"sha256sum",
	"shasum",
	"md5sum",
	"xxd",
	"od",
	"less",
	"more",
	"uname",
	"whoami",
	"ps",
	"type",
	"command",
	"mkdir",
	"unset",
	"exit",
	"wait",
]);

/** Commands whose first argument is a pattern or program rather than a file. */
const patternFirst = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"sed",
	"awk",
	"gawk",
	"jq",
	"yq",
]);

const testTools = new Set([
	"tsc",
	"biome",
	"eslint",
	"prettier",
	"vitest",
	"jest",
	"mocha",
	"ava",
	"c8",
	"nyc",
	"playwright",
	"tsx",
	"vite",
	"turbo",
	"ruff",
	"mypy",
	"pytest",
	"black",
	"isort",
	"pyright",
	"stylua",
	"shellcheck",
	"shfmt",
	"gofmt",
	"rustfmt",
]);

const runnerCommands = new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"npx",
	"bunx",
	"pnpx",
	"node",
	"deno",
	"python",
	"python3",
	"uv",
	"poetry",
	"go",
	"cargo",
	"make",
	"just",
	"nix",
	"nix-build",
	"terraform",
	"tofu",
	...testTools,
]);

/**
 * backlogic's runner scripts, which set up a cloud session's clone of a
 * ticket and report on it: its start-up entry, toolchain installer, heartbeat
 * and hook dispatcher, and the repository's checks.
 */
const backlogicScripts = new Set([
	"backlogic-cloud-enter",
	"backlogic-cloud-tools",
	"backlogic-cloud-heartbeat",
	"backlogic-cloud-hook",
]);
const backlogicChecks = new Set(["check", "wait-check"]);

/**
 * The verbs of backlogic's CLI a runner session uses on its own ticket: reads,
 * notes, frictions, heartbeats, filing and releasing. Tokens, shares, users,
 * grants, settings, the runner itself and removals stay with Aaron.
 */
const backlogicVerbs = new Set([
	"answer",
	"attach",
	"batches",
	"board",
	"boards",
	"ceilings",
	"check",
	"comment-point",
	"correction",
	"corrections",
	"done",
	"download",
	"edge",
	"edit",
	"estimates",
	"fact",
	"facts",
	"file",
	"follow-file",
	"followed-files",
	"friction",
	"frictions",
	"gate-ran",
	"hand-on",
	"hand-on-request",
	"handed-on",
	"heartbeat",
	"history",
	"link",
	"list",
	"mark",
	"marks",
	"may-stop",
	"missing-tools",
	"note",
	"nothing",
	"peers",
	"points",
	"progress",
	"pulse",
	"queued",
	"record-frictions",
	"release",
	"report",
	"request",
	"reword",
	"rules",
	"search",
	"session-end",
	"session-start",
	"show",
	"stand-down",
	"started-from",
	"step",
	"tag",
	"tags",
	"thread",
	"thread-title",
	"took-none",
	"track",
	"tracking",
	"unfollow-file",
	"unmark",
	"used",
	"waiting",
	"workarounds",
	"worked",
]);

const deployWords = /\b(deploy\w*|production|prod|release|publish)\b/i;
/** Script names that change infrastructure when a task runner runs them. */
const infrastructureWords = /\b(apply|destroy|teardown|rollback|migrate)\b/i;
const secretVariable =
	/\$\{?\w*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i;

type Context = Place & { onMain: boolean };

/** Variables that make a later command run something else: git's and ssh's commands, pagers, editors, preloads, shell hooks. */
const commandVariables =
	/^(LD_\w+|DYLD_\w+|GIT_\w+|SSH_\w+|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PAGER|MANPAGER|EDITOR|VISUAL|PS4|PROMPT_COMMAND|IFS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|SHELLOPTS|BASHOPTS|CDPATH)$/;

/**
 * Whether an assignment could change what a later command runs. PATH may
 * only gain absolute directories outside home, temp and the session's
 * folder, such as /opt/node24/bin.
 */
const riskyAssignment = (text: string): boolean => {
	const at = text.indexOf("=");
	const name = text.slice(0, at);
	const value = text.slice(at + 1);
	if (commandVariables.test(name)) return true;
	if (name !== "PATH") return false;
	return value
		.split(":")
		.some(
			(dir) =>
				!/^\$\{?PATH\}?$/.test(dir) &&
				(!isAbsolute(dir) ||
					dir.includes("$") ||
					dir.split("/").includes("..") ||
					inTemp(dir) ||
					!systemRoots.some((root) => under(dir, root))),
		);
};

const positionals = (words: Word[]): Word[] => {
	const found: Word[] = [];
	let flags = true;
	for (const word of words) {
		if (flags && word.text === "--") flags = false;
		else if (!flags || !word.text.startsWith("-") || word.text === "-") {
			found.push(word);
		}
	}
	return found;
};

const has = (words: Word[], ...flags: string[]) =>
	words.some(({ text }) =>
		flags.some((flag) =>
			flag.endsWith("=")
				? text.startsWith(flag)
				: text === flag ||
					(/^-[A-Za-z]$/.test(flag) &&
						/^-[A-Za-z]+$/.test(text) &&
						text.includes(flag[1] as string)),
		),
	);

const shown = (segment: Segment) =>
	segment.words
		.map(({ text }) => text)
		.join(" ")
		.slice(0, 80);

const pathsWritable = (paths: Word[], place: Place): SafeVerdict => {
	for (const path of paths) {
		if (path.dynamic && !tempVariable(path.text)) {
			return unsafe(`writes ${path.text}, a path the board cannot read`);
		}
		const verdict = fileVerdict(path.text, place);
		if (!verdict.safe) return verdict;
	}
	return safe;
};

const gitValueFlags = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
const gitConfigAllowed =
	/^(color\.|advice\.|user\.(name|email)=|core\.quotepath=|commit\.gpgsign=|init\.defaultbranch=|core\.pager=cat$)/i;

const gitSafe = new Set([
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"fetch",
	"pull",
	"checkout",
	"switch",
	"add",
	"commit",
	"stash",
	"rebase",
	"merge",
	"worktree",
	"restore",
	"reset",
	"push",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"blame",
	"describe",
	"shortlog",
	"grep",
	"cherry-pick",
	"revert",
	"reflog",
	"cat-file",
	"merge-base",
	"rev-list",
	"show-ref",
	"name-rev",
	"range-diff",
	"apply",
	"mv",
	"rm",
	"remote",
	"config",
	"tag",
	"version",
]);

const pushVerdict = (args: Word[]): SafeVerdict => {
	if (
		has(args, "-f", "--force", "--force-with-lease", "--force-if-includes") ||
		args.some(({ text }) => text.startsWith("--force-with-lease="))
	) {
		return unsafe("force pushes");
	}
	if (has(args, "-d", "--delete")) return unsafe("deletes a remote branch");
	if (has(args, "--mirror", "--all", "--prune")) {
		return unsafe("pushes or prunes every branch");
	}
	if (has(args, "--tags", "--follow-tags")) return unsafe("pushes tags");
	const valued = new Set(["-o", "--push-option", "--repo"]);
	const rest: Word[] = [];
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] as Word;
		if (valued.has(arg.text)) at += 1;
		else if (!arg.text.startsWith("-")) rest.push(arg);
	}
	const refspecs = rest.slice(1);
	if (refspecs.length === 0) {
		return unsafe(
			"pushes the current branch, which the board cannot see; name the branch",
		);
	}
	for (const spec of refspecs) {
		if (spec.dynamic)
			return unsafe(`pushes ${spec.text}, which the board cannot read`);
		if (spec.text.startsWith("+")) return unsafe("force pushes");
		if (spec.text === "tag") return unsafe("pushes tags");
		if (spec.text.startsWith(":")) return unsafe("deletes a remote branch");
		const target = spec.text.includes(":")
			? spec.text.slice(spec.text.indexOf(":") + 1)
			: spec.text;
		if (mainBranch(target)) return unsafe(`pushes to ${target}`);
		if (target === "HEAD" || target === "@") {
			return unsafe(
				"pushes the current branch, which the board cannot see; name the branch",
			);
		}
		if (target.startsWith("refs/tags/")) return unsafe("pushes tags");
	}
	return safe;
};

const gitVerdict = (words: Word[], context: Context): SafeVerdict => {
	let at = 1;
	while (at < words.length && (words[at] as Word).text.startsWith("-")) {
		const flag = (words[at] as Word).text;
		if (
			(flag === "-c" && !gitConfigAllowed.test(words[at + 1]?.text ?? "")) ||
			flag.startsWith("--config-env") ||
			flag.startsWith("--exec-path=")
		) {
			return unsafe("sets git configuration that could run a command");
		}
		at += gitValueFlags.has(flag) ? 2 : 1;
	}
	const sub = words[at]?.text ?? "";
	const args = words.slice(at + 1);
	const named = positionals(args).map(({ text }) => text);
	if (
		args.some(({ text }) =>
			/^--(upload-pack|receive-pack|exec|ext-diff|textconv)(=|$)/.test(text),
		) ||
		(["fetch", "pull", "ls-remote"].includes(sub) && has(args, "-u"))
	) {
		return unsafe("runs a command git is given");
	}
	if (args.some(({ text }) => /^--output(=|$)/.test(text))) {
		return unsafe("writes git's output to a file");
	}
	switch (sub) {
		case "rebase":
			return has(args, "-x") ? unsafe("runs a command git is given") : safe;
		case "push":
			return pushVerdict(args);
		case "clean":
			return unsafe("deletes untracked files");
		case "branch":
			return has(args, "-d", "-D", "--delete")
				? unsafe("deletes a branch")
				: safe;
		case "tag":
			if (has(args, "-d", "--delete")) return unsafe("deletes a tag");
			return named.length === 0 || has(args, "-l", "--list", "--contains")
				? safe
				: unsafe("creates a tag");
		case "stash":
			return named[0] === "drop" || named[0] === "clear"
				? unsafe("drops stashed work")
				: safe;
		case "merge":
			return context.onMain ? unsafe("merges into main") : safe;
		case "checkout":
		case "switch":
			if (named.some(mainBranch)) context.onMain = true;
			return safe;
		case "remote":
			return named.length === 0 || ["show", "get-url"].includes(named[0] ?? "")
				? safe
				: unsafe("changes git remotes");
		case "config":
			return has(args, "--get", "--get-all", "--get-regexp", "--list", "-l")
				? safe
				: unsafe("changes git configuration");
		default:
			return gitSafe.has(sub) ? safe : unsafe(notInSafeSet);
	}
};

const ghValueFlags = new Set(["-R", "--repo", "--hostname"]);
const ghSafe: Record<string, string[]> = {
	pr: [
		"view",
		"list",
		"checks",
		"diff",
		"create",
		"comment",
		"review",
		"status",
	],
	issue: ["view", "list", "create", "comment", "status"],
	run: ["view", "list", "watch"],
	repo: ["view"],
	search: ["issues", "prs", "code", "repos", "commits"],
};

const ghApiVerdict = (args: Word[]): SafeVerdict => {
	let method: string | null = null;
	for (const [at, { text }] of args.entries()) {
		if (text === "-X" || text === "--method") method = args[at + 1]?.text ?? "";
		else if (text.startsWith("--method=")) method = text.slice(9);
		else if (/^-X./.test(text)) method = text.slice(2);
	}
	const fields = has(args, "-f", "-F", "--field", "--raw-field", "--input");
	const upper = method?.toUpperCase() ?? (fields ? "POST" : "GET");
	if (upper !== "GET") return unsafe(`sends a ${upper} to GitHub's API`);
	if (positionals(args)[0]?.text === "graphql") {
		return unsafe("posts to GitHub's GraphQL API");
	}
	return safe;
};

const ghVerdict = (words: Word[]): SafeVerdict => {
	const rest: Word[] = [];
	for (let at = 1; at < words.length; at++) {
		const word = words[at] as Word;
		if (ghValueFlags.has(word.text)) at += 1;
		else rest.push(word);
	}
	const [group = "", sub = ""] = positionals(rest).map(({ text }) => text);
	if (group === "pr" && sub === "merge") return unsafe("merges a pull request");
	if (group === "repo" && sub === "delete")
		return unsafe("deletes a repository");
	if (group === "release") return unsafe("touches releases");
	if (group === "secret" || (group === "auth" && sub === "token")) {
		return unsafe("reads or writes secrets");
	}
	if (group === "api") return ghApiVerdict(rest.slice(1));
	return ghSafe[group]?.includes(sub) ? safe : unsafe(notInSafeSet);
};

const packageBuiltinsRefused = new Set([
	"publish",
	"unpublish",
	"login",
	"logout",
	"adduser",
	"token",
	"owner",
	"team",
	"access",
	"deprecate",
	"dist-tag",
	"version",
	"pack",
	"add",
	"remove",
	"rm",
	"uninstall",
	"up",
	"upgrade",
	"update",
	"link",
	"unlink",
	"global",
	"config",
	"set",
	"dlx",
	"create",
	"init",
	"npm",
	"patch",
]);
const packageSafe = new Set([
	"run",
	"run-script",
	"test",
	"t",
	"tst",
	"ci",
	"install",
	"i",
	"ls",
	"list",
	"outdated",
	"why",
	"explain",
	"audit",
]);
const packageValueFlags = new Set([
	"--prefix",
	"-w",
	"--workspace",
	"-C",
	"--dir",
	"--cwd",
	"--filter",
	"-F",
]);

/** Packages whose names differ from the test tool they run. */
const testPackages = new Set([
	"typescript",
	"@biomejs/biome",
	"@playwright/test",
]);

/**
 * Whether a package spec names a known test tool from the registry: a bare
 * name or one of testPackages, with at most a plain version, never a
 * GitHub shorthand, alias, URL or path.
 */
const testPackage = (spec: string): boolean => {
	const match = /^((?:@[\w.-]+\/)?[\w.-]+)(?:@([\w.^~<>=*-]+))?$/.exec(spec);
	if (!match) return false;
	const name = match[1] as string;
	return testTools.has(name) || testPackages.has(name);
};

const toolVerdict = (words: Word[]): SafeVerdict => {
	const tool = positionals(words)[0]?.text ?? "";
	return testPackage(tool)
		? safe
		: unsafe(`runs ${tool || "a package"}, which is not a known test tool`);
};

const packageVerdict = (command: string, words: Word[]): SafeVerdict => {
	if (["npx", "bunx", "pnpx"].includes(command)) {
		const rest: Word[] = [];
		for (let at = 1; at < words.length; at++) {
			const word = words[at] as Word;
			if (word.text === "-p" || word.text === "--package") {
				const spec = words[at + 1]?.text ?? "";
				if (!testPackage(spec)) {
					return unsafe(
						`installs ${spec || "a package"}, which is not a known test tool`,
					);
				}
				at += 1;
			} else if (word.text.startsWith("--package=")) {
				if (!testPackage(word.text.slice(10))) {
					return unsafe(
						`installs ${word.text.slice(10)}, which is not a known test tool`,
					);
				}
			} else if (word.text === "-c" || word.text === "--call") {
				return unsafe("runs a shell command npx is given");
			} else rest.push(word);
		}
		return toolVerdict(rest);
	}
	let sub: string | null = null;
	let at = 1;
	for (; at < words.length; at++) {
		const word = words[at] as Word;
		if (packageValueFlags.has(word.text)) at += 1;
		else if (!word.text.startsWith("-")) {
			sub = word.text;
			break;
		}
	}
	const after = words.slice(at + 1);
	if (has(words, "-g", "--global")) return unsafe("installs globally");
	if (sub === null) return command === "npm" ? unsafe(notInSafeSet) : safe;
	if (sub === "exec" || sub === "x") {
		if (
			has(after, "-c", "--call") ||
			after.some(
				({ text }) =>
					/^--(package|call)=/.test(text) ||
					text === "-p" ||
					text === "--package",
			)
		) {
			return unsafe("runs a package or command the board cannot judge");
		}
		return toolVerdict(after);
	}
	if (["install", "i", "add"].includes(sub) && positionals(after).length > 0) {
		return unsafe("adds a package");
	}
	if (packageSafe.has(sub)) return safe;
	if (command === "npm" || packageBuiltinsRefused.has(sub)) {
		return unsafe(notInSafeSet);
	}
	return safe;
};

const nixVerdict = (words: Word[]): SafeVerdict => {
	const twoValues = new Set(["--option", "--override-input"]);
	const oneValue = new Set([
		"--extra-experimental-features",
		"--experimental-features",
		"--store",
		"-I",
	]);
	const named: string[] = [];
	for (let at = 1; at < words.length && named.length < 2; at++) {
		const { text } = words[at] as Word;
		if (twoValues.has(text)) at += 2;
		else if (oneValue.has(text)) at += 1;
		else if (!text.startsWith("-")) named.push(text);
	}
	const [sub = "", next = ""] = named;
	if (
		["build", "eval", "log", "path-info", "why-depends", "fmt"].includes(sub)
	) {
		return safe;
	}
	return sub === "flake" && ["check", "show", "metadata", "info"].includes(next)
		? safe
		: unsafe(notInSafeSet);
};

const terraformVerdict = (words: Word[]): SafeVerdict => {
	const named = positionals(words.slice(1)).map(({ text }) => text);
	const [sub = "", next = ""] = named;
	if (
		["apply", "destroy", "import", "taint", "untaint", "force-unlock"].includes(
			sub,
		)
	) {
		return unsafe(`${sub} changes infrastructure`);
	}
	if (
		sub === "state" &&
		["rm", "mv", "push", "replace-provider"].includes(next)
	) {
		return unsafe("changes infrastructure state");
	}
	return [
		"fmt",
		"validate",
		"plan",
		"init",
		"version",
		"providers",
		"graph",
	].includes(sub)
		? safe
		: unsafe(notInSafeSet);
};

const infrastructureVerdict = (command: string, words: Word[]): SafeVerdict => {
	const named = positionals(words.slice(1)).map(({ text }) => text);
	const [sub = ""] = named;
	if (
		command === "pulumi" &&
		["up", "destroy", "refresh", "import"].includes(sub)
	) {
		return unsafe("changes infrastructure");
	}
	if (command === "cdk" && ["deploy", "destroy", "bootstrap"].includes(sub)) {
		return unsafe("changes infrastructure");
	}
	if (
		command === "kubectl" &&
		!["get", "describe", "logs", "top", "version", "explain"].includes(sub)
	) {
		return unsafe("changes the cluster");
	}
	if (
		command === "helm" &&
		["install", "upgrade", "uninstall", "rollback", "delete"].includes(sub)
	) {
		return unsafe("changes the cluster");
	}
	if (command === "aws" && sub === "configure") {
		return unsafe("reads or writes cloud credentials");
	}
	if (
		["aws", "gcloud", "az"].includes(command) &&
		!named.some((word) => /^(describe|list|get|show|ls)\b/.test(word))
	) {
		return unsafe("changes cloud resources");
	}
	if (["serverless", "sls"].includes(command) && sub === "deploy") {
		return unsafe("deploys");
	}
	return unsafe(notInSafeSet);
};

const curlVerdict = (
	command: string,
	words: Word[],
	place: Place,
): SafeVerdict => {
	const args = words.slice(1);
	for (const [at, { text }] of args.entries()) {
		const method =
			text === "-X" || text === "--request"
				? args[at + 1]?.text
				: text.startsWith("--request=")
					? text.slice(10)
					: /^-X./.test(text)
						? text.slice(2)
						: undefined;
		if (method !== undefined && method.toUpperCase() !== "GET") {
			return unsafe(`sends a ${method.toUpperCase()} request`);
		}
		if (
			/^--(data|json|form|upload-file|post)/.test(text) ||
			["-d", "-F", "-T"].includes(text)
		) {
			return unsafe("sends data");
		}
		if (command === "wget" && /^--(post|body|method)/.test(text)) {
			return unsafe("sends data");
		}
		if (["-o", "--output", "-O", "--output-document"].includes(text)) {
			const target = args[at + 1];
			if (command === "curl" && text === "-O") continue;
			if (target && target.text !== "-") {
				const verdict = pathsWritable([target], place);
				if (!verdict.safe) return verdict;
			}
		}
	}
	return safe;
};

const pythonModules = new Set([
	"pytest",
	"mypy",
	"ruff",
	"unittest",
	"compileall",
	"black",
	"isort",
	"pyright",
]);

const subcommand = (words: Word[], valueFlags: Set<string>) => {
	for (let at = 1; at < words.length; at++) {
		const { text } = words[at] as Word;
		if (valueFlags.has(text)) at += 1;
		else if (!text.startsWith("-")) return at;
	}
	return -1;
};

const uvValueFlags = new Set([
	"--with",
	"--python",
	"-p",
	"--package",
	"--directory",
	"--project",
	"--extra",
	"--group",
	"--env-file",
]);

const segmentVerdict = (segment: Segment, context: Context): SafeVerdict => {
	let words = segment.words;
	for (const redirect of segment.redirects) {
		if (redirect.op.includes(">")) {
			if (
				["/dev/null", "/dev/stdout", "/dev/stderr"].includes(
					redirect.target.text,
				)
			) {
				continue;
			}
			const verdict = pathsWritable([redirect.target], context);
			if (!verdict.safe) return verdict;
		} else if (redirect.op === "<" && secretRead(redirect.target.text)) {
			return unsafe(`reads a secret-like file ${redirect.target.text}`);
		}
	}
	if (words.some(({ text }) => secretVariable.test(text))) {
		return unsafe("uses a secret from the environment");
	}
	for (;;) {
		const first = words[0]?.text ?? "";
		if (
			[
				"if",
				"then",
				"else",
				"elif",
				"do",
				"while",
				"until",
				"!",
				"{",
				"}",
				"time",
				"nohup",
			].includes(first)
		) {
			words = words.slice(1);
		} else if (first === "command" && words[1]?.text !== "-v") {
			words = words.slice(1);
		} else if (first === "timeout") {
			const at = subcommand(
				words,
				new Set(["-s", "--signal", "-k", "--kill-after"]),
			);
			words = at === -1 ? [] : words.slice(at + 1);
		} else if (first === "nice") {
			const at = subcommand(words, new Set(["-n", "--adjustment"]));
			words = at === -1 ? [] : words.slice(at);
		} else if (first === "xargs") {
			const at = subcommand(
				words,
				new Set(["-n", "-I", "-P", "-L", "-d", "-s", "-E"]),
			);
			words = at === -1 ? [] : words.slice(at);
			const fed = basename(words[0]?.text ?? "");
			if (
				["rm", "rmdir", "unlink", "mv", "cp", "tee", "touch", "chmod"].includes(
					fed,
				)
			) {
				return unsafe(`runs ${fed} on files it reads from its input`);
			}
		} else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
			if (riskyAssignment(first)) {
				return unsafe(`sets ${first.split("=")[0]}, which can run a command`);
			}
			words = words.slice(1);
		} else if (first === "env" && words.length > 1) {
			const rest = words.slice(1);
			const at = rest.findIndex(
				({ text }) =>
					!/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) && !text.startsWith("-"),
			);
			if (at === -1)
				return unsafe("prints the environment, which holds secrets");
			const risky = rest
				.slice(0, at)
				.find(
					({ text }) => /^[A-Za-z_]\w*=/.test(text) && riskyAssignment(text),
				);
			if (risky) {
				return unsafe(
					`sets ${risky.text.split("=")[0]}, which can run a command`,
				);
			}
			if (rest.slice(0, at).some(({ text }) => text.startsWith("-"))) {
				return unsafe("runs env with options the board does not read");
			}
			words = rest.slice(at);
		} else break;
	}
	if (words.length === 0) return safe;
	const head = words[0] as Word;
	if (head.dynamic) return unsafe("runs a command the board cannot read");
	const command = basename(head.text);
	const args = words.slice(1);
	const named = positionals(args);

	if (
		(command === "." || command === "source") &&
		args.length === 1 &&
		/^(~|\$\{?HOME\}?)\/\.backlogic-cloud$/.test(args[0]?.text ?? "")
	) {
		return safe;
	}
	if (backlogicScripts.has(command)) return safe;
	if (backlogicChecks.has(command) && /(^|\/)bin\/[^/]+$/.test(head.text)) {
		return safe;
	}
	if (command === "backlogic") {
		const verb = named[0]?.text ?? "";
		return backlogicVerbs.has(verb)
			? safe
			: unsafe(`runs backlogic ${verb || "with no verb"}, not in the safe set`);
	}
	if (["done", "fi", "esac"].includes(command) && args.length === 0)
		return safe;
	if (command === "for") return safe;
	if (["sudo", "doas", "su"].includes(command)) return unsafe("runs as root");
	if (["ssh", "scp", "sftp", "mosh", "telnet"].includes(command)) {
		return unsafe("reaches another host");
	}
	if (command === "rsync" && named.some(({ text }) => /^[^/]*:/.test(text))) {
		return unsafe("reaches another host");
	}
	if (
		["printenv", "env", "set"].includes(command) &&
		named.length === 0 &&
		!(command === "set" && args.length > 0)
	) {
		return unsafe("prints the environment, which holds secrets");
	}
	if (command === "export") {
		if (
			!named.every(({ text }) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) ||
			named.length === 0 ||
			args.length !== named.length
		) {
			return unsafe("prints the environment, which holds secrets");
		}
		const risky = named.find(({ text }) => riskyAssignment(text));
		return risky
			? unsafe(`sets ${risky.text.split("=")[0]}, which can run a command`)
			: safe;
	}
	if (command === "set") return safe;
	if (command === "security") return unsafe("reads the keychain");
	if (["sendmail", "mail", "mailx", "mutt"].includes(command)) {
		return unsafe("sends mail");
	}
	if (reviewTools().some((name) => command.toLowerCase().startsWith(name))) {
		return words.some(({ text }) => /merge|deploy|delete|destroy/i.test(text))
			? unsafe("merges, deploys or deletes")
			: safe;
	}
	if (
		runnerCommands.has(command) &&
		args.some(({ text }) => deployWords.test(text))
	) {
		return unsafe("mentions deploying, releasing or production");
	}
	if (
		["make", "just", "npm", "pnpm", "yarn", "bun"].includes(command) &&
		args.some(({ text }) => infrastructureWords.test(text))
	) {
		return unsafe("runs a task that may apply or destroy infrastructure");
	}
	if (
		["node", "bun", "tsx", "deno"].includes(command) &&
		args.some(({ text }) =>
			/^(-e|--eval|-p|--print|-pe|-ep)$|^--(eval|print)=/.test(text),
		)
	) {
		return unsafe(
			"evaluates code that runs commands, deletes or reads the environment",
		);
	}

	if (command === "cd" || command === "pushd" || command === "popd") {
		const target = named[0];
		if (
			!target ||
			target.dynamic ||
			homeRelative(target.text) ||
			target.text === "-" ||
			command === "popd"
		) {
			context.dir = null;
		} else if (isAbsolute(target.text)) {
			context.dir = normalize(target.text);
		} else if (context.dir !== null) {
			const base = context.dir ?? context.root;
			context.dir =
				base === undefined
					? target.text.split(/[\\/]+/).includes("..")
						? null
						: undefined
					: resolve(base, target.text);
		}
		return safe;
	}
	if (readCommands.has(command)) {
		if (command === "find") {
			if (has(args, "-delete")) return unsafe("deletes files");
			const exec = args.findIndex(({ text }) =>
				["-exec", "-execdir", "-ok", "-okdir"].includes(text),
			);
			if (exec !== -1) {
				const end = args.findIndex(
					({ text }, at) => at > exec && (text === ";" || text === "+"),
				);
				const inner = args.slice(exec + 1, end === -1 ? undefined : end);
				if (
					["rm", "rmdir", "unlink", "mv", "shred"].includes(
						inner[0]?.text ?? "",
					)
				) {
					return unsafe("deletes or moves the files it finds");
				}
				return segmentVerdict({ words: inner, redirects: [] }, context);
			}
		}
		if (
			command === "sed" &&
			args.some(({ text }) => /^-[A-Za-z]*i|^--in-place/.test(text))
		) {
			return unsafe("edits files in place");
		}
		if (command === "sed") {
			// e runs a command and w, W or the s///w flag writes a file,
			// after any address; the board cannot tell them from text, so
			// any e or w standing alone in a script asks.
			const scripts = [
				...named.slice(0, has(args, "-e") ? named.length : 1),
				...args
					.filter(({ text }) => text.startsWith("--expression="))
					.map(({ text }) => ({ text: text.slice(13), dynamic: false })),
			];
			if (
				has(args, "-f", "--file") ||
				args.some(({ text }) => text.startsWith("--file=")) ||
				scripts.some(({ text }) =>
					/(^|[^A-Za-z\\])[ewW]($|[^A-Za-z])/.test(text),
				)
			) {
				return unsafe("runs or writes from a sed script");
			}
		}
		if (
			(command === "awk" || command === "gawk") &&
			(has(args, "-f", "--file") ||
				named.some(({ text }) =>
					/system\s*\(|\||>\s*[^\s0-9=]|ENVIRON|PROCINFO|@load|@include/.test(
						text,
					),
				))
		) {
			return unsafe(
				"runs a command, writes or reads the environment from an awk program",
			);
		}
		if (
			(command === "jq" || command === "yq") &&
			args.some(({ text }) =>
				/\benv\b|\$ENV\b|\bstrenv\b|\bload(str)?\s*\(|\b(include|import)\s+"/.test(
					text,
				),
			)
		) {
			return unsafe("reads the environment or other files from a jq program");
		}
		if (
			command === "ps" &&
			(/^[A-Za-z]*e[A-Za-z]*$/.test(args[0]?.text ?? "") ||
				args.some(({ text }) => /^-[A-Za-z]*E/.test(text)))
		) {
			return unsafe("shows processes' environments, which hold secrets");
		}
		if (command === "find") {
			const writes = args.findIndex(({ text }) =>
				["-fprint", "-fprint0", "-fprintf", "-fls"].includes(text),
			);
			if (writes !== -1) {
				const verdict = pathsWritable(
					args.slice(writes + 1, writes + 2),
					context,
				);
				if (!verdict.safe) return verdict;
			}
		}
		if (
			(command === "sort" &&
				(has(args, "-o") ||
					args.some(({ text }) => text.startsWith("--output")))) ||
			(command === "tree" && has(args, "-o")) ||
			(command === "xxd" && has(args, "-r"))
		) {
			return unsafe(`writes a file through ${command}`);
		}
		if (command === "uniq" && named.length > 1) {
			const verdict = pathsWritable(named.slice(1, 2), context);
			if (!verdict.safe) return verdict;
		}
		const files =
			patternFirst.has(command) && !has(args, "-e", "-f")
				? named.slice(1)
				: named;
		const secret = files.find(({ text }) => secretRead(text));
		if (secret) return unsafe(`reads a secret-like file ${secret.text}`);
		return safe;
	}
	switch (command) {
		case "git":
			return gitVerdict(words, context);
		case "gh":
			return ghVerdict(words);
		case "rm": {
			const { root, dir } = context;
			if (named.length === 0) return safe;
			for (const path of named) {
				if (
					path.dynamic ||
					homeRelative(path.text) ||
					path.text.split(/[\\/]+/).includes("..") ||
					(dir === null && !isAbsolute(path.text))
				) {
					return unsafe(`deletes ${path.text}, a path the board cannot read`);
				}
				const base = dir ?? root;
				const full = base === undefined ? null : resolve(base, path.text);
				if (full === null) {
					if (isAbsolute(path.text) && inTemp(normalize(path.text))) continue;
					return unsafe(
						"deletes files, and the board does not know the session's folder",
					);
				}
				if (inTemp(full) && !(root && under(full, resolve(root)))) continue;
				if (!root || !under(full, resolve(root))) {
					return unsafe(`deletes ${path.text}, outside the session's folder`);
				}
				if (
					full === resolve(root) ||
					gitInternal(full) ||
					(/[*?[]/.test(basename(full)) &&
						resolve(full, "..") === resolve(root))
				) {
					return unsafe(
						`deletes ${path.text}, the session's whole folder or its git data`,
					);
				}
			}
			return safe;
		}
		case "cp":
		case "mv":
		case "tee":
		case "touch":
		case "chmod": {
			const targetDirectory =
				(command === "cp" || command === "mv") &&
				(has(args, "-t") ||
					args.some(({ text }) => text.startsWith("--target-directory")));
			if (targetDirectory) {
				const given = args
					.filter(({ text }) => text.startsWith("--target-directory="))
					.map(({ text }) => ({ text: text.slice(19), dynamic: false }));
				const verdict = pathsWritable([...named, ...given], context);
				if (!verdict.safe) return verdict;
				if (command === "cp") {
					const secret = named.find(({ text }) => secretRead(text));
					if (secret) return unsafe(`reads a secret-like file ${secret.text}`);
				}
				return safe;
			}
			const targets =
				command === "cp"
					? named.slice(-1)
					: command === "chmod"
						? named.slice(1)
						: named;
			const sources = command === "cp" ? named.slice(0, -1) : [];
			const secret = sources.find(({ text }) => secretRead(text));
			if (secret) return unsafe(`reads a secret-like file ${secret.text}`);
			return pathsWritable(targets, context);
		}
		case "curl":
		case "wget":
			return curlVerdict(command, words, context);
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
		case "npx":
		case "bunx":
		case "pnpx":
			if (command === "bun" && named[0]?.text === "x")
				return toolVerdict(named.slice(1));
			return packageVerdict(command, words);
		case "node":
			// A script of the repository runs, as a test or build would; a
			// program from stdin or a heredoc is code the board never sees.
			if (
				(named.length === 0 || named[0]?.text === "-") &&
				!has(args, "--test", "--version", "-v", "--help", "-h")
			) {
				return unsafe("runs a program from its input");
			}
			return safe;
		case "deno":
			return ["test", "check", "lint", "fmt"].includes(named[0]?.text ?? "") ||
				(named.length === 0 && has(args, "--version", "-V"))
				? safe
				: unsafe(notInSafeSet);
		case "python":
		case "python3": {
			const module = args.findIndex(({ text }) => text === "-m");
			if (module !== -1) {
				return pythonModules.has(args[module + 1]?.text ?? "")
					? safe
					: unsafe(notInSafeSet);
			}
			return has(args, "--version", "-V") && named.length === 0
				? safe
				: unsafe(notInSafeSet);
		}
		case "uv":
		case "poetry": {
			const at = subcommand(words, uvValueFlags);
			const sub = at === -1 ? "" : (words[at] as Word).text;
			if (sub === "run") {
				const rest = words.slice(at + 1);
				const start = rest.findIndex(
					({ text }, index) =>
						!text.startsWith("-") &&
						!uvValueFlags.has(rest[index - 1]?.text ?? ""),
				);
				return start === -1
					? unsafe(notInSafeSet)
					: segmentVerdict(
							{ words: rest.slice(start), redirects: [] },
							context,
						);
			}
			return ["sync", "lock", "tree", "install", "check", "show"].includes(sub)
				? safe
				: unsafe(notInSafeSet);
		}
		case "go": {
			const [sub = "", next = ""] = named.map(({ text }) => text);
			if (["test", "build", "vet", "fmt", "list", "version"].includes(sub))
				return safe;
			return sub === "mod" &&
				["tidy", "download", "verify", "graph", "why"].includes(next)
				? safe
				: unsafe(notInSafeSet);
		}
		case "cargo":
			return [
				"test",
				"build",
				"check",
				"clippy",
				"fmt",
				"doc",
				"metadata",
				"tree",
				"bench",
				"nextest",
			].includes(named[0]?.text ?? "")
				? safe
				: unsafe(notInSafeSet);
		case "mise":
			return [
				"install",
				"ls",
				"list",
				"which",
				"current",
				"version",
				"--version",
			].includes(named[0]?.text ?? (has(args, "--version") ? "--version" : ""))
				? safe
				: unsafe(notInSafeSet);
		case "make":
		case "just":
			return safe;
		case "nix":
			return nixVerdict(words);
		case "nix-build":
			return safe;
		case "terraform":
		case "tofu":
			return terraformVerdict(words);
		case "pulumi":
		case "cdk":
		case "kubectl":
		case "helm":
		case "aws":
		case "gcloud":
		case "az":
		case "serverless":
		case "sls":
			return infrastructureVerdict(command, words);
		default:
			return testTools.has(command) ? safe : unsafe(notInSafeSet);
	}
};

const globalGuards: [RegExp, string][] = [
	[/allow_destroy/i, "mentions allow_destroy"],
	[/slack\.com\/api\/|hooks\.slack\.com/i, "posts to Slack"],
	[
		/discord(app)?\.com\/api\/webhooks|api\.telegram\.org|graph\.microsoft\.com|gmail\.googleapis\.com/i,
		"touches mail or messaging",
	],
	[
		/\b(sendmail|smtp|swaks|msmtp|twilio|sendgrid|mailgun|stripe|paypal|payments?)\b/i,
		"touches mail, messaging or payments",
	],
];

/** Whether every simple command in a shell command line is safe. */
export const bashVerdict = (command: string, cwd?: string): SafeVerdict => {
	for (const [pattern, reason] of globalGuards) {
		if (pattern.test(command)) return unsafe(reason);
	}
	let segments: Segment[];
	try {
		segments = parseShell(command);
	} catch (error) {
		return unsafe(
			error instanceof ShellSyntax
				? `the board could not read the command: it has ${error.message}`
				: "the board could not read the command",
		);
	}
	if (segments.length === 0) return unsafe("runs no command");
	const context: Context = { ...(cwd ? { root: cwd } : {}), onMain: false };
	for (const segment of segments) {
		const verdict = segmentVerdict(segment, context);
		if (!verdict.safe) {
			return unsafe(`${verdict.reason} (${shown(segment)})`);
		}
	}
	return safe;
};
