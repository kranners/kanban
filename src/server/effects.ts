// The serious set: the effects that still need Aaron, judged by what a cloud
// session's prompt does, never by how. A cloud session's container is
// scratch, so deleting or writing its own files is never serious. Everything
// else it asks for is harmless and the board allows it at once.

const remotePrefix = "mcp__claude-code-remote__";

const accessRemote = new Set([
	"create_environment",
	"update_environment",
	"switch_environment",
	"request_credential",
	"request_computer_folder",
	"confirm_repository_trust",
]);

const access = "Change an account, access or security setting";
const deploy = "Deploy or change production";
const destroy = "Delete production data or cloud resources";
const send = "Send a message as Aaron";
const secretLeaves = "Send a secret off the machine";

/** A shell command as segments of words, quotes removed, split outside quotes on operators and substitutions. */
export const segmentsOf = (command: string): string[][] => {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let quote: string | null = null;
	let quoted = false;
	const endWord = () => {
		if (word !== "" || quoted) words.push(word);
		word = "";
		quoted = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};
	for (let at = 0; at < command.length; at++) {
		const char = command[at] ?? "";
		if (quote) {
			if (char === quote) quote = null;
			else if (char === "\\" && quote === '"') word += command[++at] ?? "";
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			quoted = true;
		} else if (char === "\\") {
			word += command[++at] ?? "";
		} else if (char === "$" && command[at + 1] === "(") {
			endSegment();
			at++;
		} else if (/[;&|()`\n]/.test(char)) {
			endSegment();
		} else if (/\s/.test(char)) {
			endWord();
		} else {
			word += char;
		}
	}
	endSegment();
	return segments;
};

const baseName = (word: string) => word.split("/").at(-1) ?? word;

const wrappers =
	/^(sudo|doas|env|nohup|time|command|exec|nice|ionice|timeout|stdbuf|xargs|butler-root)$/;
const wrapperValues = /^-[ugCDhprtnkscIP]$/;

/** The command a segment runs, past variable assignments and wrappers such as sudo -u and timeout. */
const unwrapped = (argv: readonly string[]): string[] => {
	let rest = [...argv];
	while (rest.length > 0) {
		const head = rest[0] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
			rest = rest.slice(1);
			continue;
		}
		if (!wrappers.test(baseName(head))) break;
		rest = rest.slice(1);
		while ((rest[0] ?? "").startsWith("-")) {
			const flag = rest.shift() ?? "";
			if (wrapperValues.test(flag)) rest.shift();
		}
		if (baseName(head) === "timeout" && /^\d/.test(rest[0] ?? "")) {
			rest.shift();
		}
	}
	return rest.length > 0 ? [baseName(rest[0] ?? ""), ...rest.slice(1)] : [];
};

const valueFlags =
	/^(-[A-Za-z]|--(context|namespace|chdir|repo|profile|region|project|kubeconfig|app|config))$/;

/** A command's arguments from its first that is not a flag, skipping flags and their values. */
const subcommand = (argv: readonly string[]): string[] => {
	const rest = argv.slice(1);
	while (rest.length > 0 && (rest[0] ?? "").startsWith("-")) {
		const flag = rest.shift() ?? "";
		if (valueFlags.test(flag)) rest.shift();
	}
	return rest;
};

/** Commands that only print, search or record text, whose words never act. */
const textOnly = new Set([
	"echo",
	"printf",
	"grep",
	"rg",
	"ag",
	"cat",
	"less",
	"head",
	"tail",
	"jq",
	"yq",
	"wc",
	"sort",
	"diff",
	"getent",
	"man",
	"which",
	"type",
]);

const gitText = new Set([
	"log",
	"show",
	"diff",
	"grep",
	"commit",
	"blame",
	"status",
]);

const dryRun = (argv: readonly string[]) =>
	argv.some((word) => /^--(dry-run|help|server-dry-run)\b|^-h$/.test(word));

const secretFile =
	/(^|\/)(\.env(rc)?$|\.env\.(?!example$|sample$|template$)[\w-]+$|\.ssh(\/|$)|id_(rsa|ed25519|ecdsa)$|[\w.-]+\.(pem|p12)$|\.aws\/credentials$|\.netrc$|credentials(\.json)?$|secrets?\.(ya?ml|json)$|hosts\.yml$)|^\/var\/lib\/secrets\//;

const uploaded = (argv: readonly string[]): string[] =>
	argv.flatMap((word, at) => {
		const next = argv[at + 1] ?? "";
		if (/^(-d|--data(-binary|-raw|-urlencode)?|-F|--form)$/.test(word)) {
			return next.includes("@") ? [next.replace(/^[^@]*@/, "")] : [];
		}
		return /^(-T|--upload-file)$/.test(word) ? [next] : [];
	});

const loopback = (argv: readonly string[]) =>
	argv.some((word) =>
		/^(https?:\/\/)?(localhost|127\.|\[?::1\]?)|@(localhost|127\.)/.test(word),
	);

const sendHosts =
	/hooks\.slack\.com|slack\.com\/api\/chat\.|api\.sendgrid\.com|api\.mailgun\.net|api\.twilio\.com|api\.postmarkapp\.com|graph\.facebook\.com|api\.telegram\.org|gmail\.googleapis\.com\/.*\/send|api\.(twitter|x)\.com|discord(app)?\.com\/api\/webhooks/;

const gitPush = (args: readonly string[]): string | null => {
	if (
		args.some(
			(arg) => arg === "-f" || arg.startsWith("--force") || arg === "--mirror",
		)
	) {
		return "Force push";
	}
	const refs = args.filter((arg) => !arg.startsWith("-")).slice(2);
	if (refs.some((ref) => ref.startsWith("+") && ref.length > 1)) {
		return "Force push";
	}
	if (refs.some((ref) => /(^|:)(refs\/heads\/)?(main|master)$/.test(ref))) {
		return "Push to main without review";
	}
	if (refs.some((ref) => ref.startsWith(":")))
		return "Delete a branch on GitHub";
	return null;
};

const toolEffect = (tool: string, args: readonly string[]): string | null => {
	const [verb = "", second = ""] = args;
	switch (tool) {
		case "terraform":
		case "tofu":
			return verb === "destroy" ? destroy : verb === "apply" ? deploy : null;
		case "pulumi":
			return verb === "destroy" ? destroy : verb === "up" ? deploy : null;
		case "kubectl":
			if (verb === "delete") return destroy;
			if (/^(apply|scale|set|patch|replace|edit|create)$/.test(verb)) {
				return deploy;
			}
			return verb === "rollout" && /^(restart|undo)$/.test(second)
				? deploy
				: null;
		case "helm":
			if (/^(uninstall|delete)$/.test(verb)) return destroy;
			return /^(install|upgrade|rollback)$/.test(verb) ? deploy : null;
		case "fly":
		case "flyctl":
			if (args.includes("destroy")) return destroy;
			return /^(deploy|scale|secrets)$/.test(verb) ? deploy : null;
		case "heroku":
			return /destroy/.test(verb) ? destroy : null;
		case "cdk":
		case "sst":
		case "serverless":
		case "sls":
		case "wrangler":
		case "vercel":
		case "netlify":
		case "railway":
			if (/^(destroy|remove|delete)$/.test(verb)) return destroy;
			if (tool === "wrangler" && verb === "d1" && second === "execute") {
				return deploy;
			}
			return /^(deploy|publish|up)$/.test(verb) || args.includes("--prod")
				? deploy
				: null;
		case "aws":
			if (verb === "s3") {
				if (/^(rm|rb)$/.test(second)) return destroy;
				return second === "sync" && args.includes("--delete") ? destroy : null;
			}
			if (verb === "iam" && !/^(get|list|simulate)-/.test(second)) {
				return access;
			}
			if (/^(delete|terminate)-/.test(second)) return destroy;
			return /^(create|put|update|modify|run|start|stop|attach|detach)-/.test(
				second,
			) && !/^start-(query|session)/.test(second)
				? deploy
				: null;
		case "gcloud":
		case "az":
		case "doctl":
			if (/^(components|config|auth|account|login)$/.test(verb)) return null;
			if (args.includes("delete")) return destroy;
			return args.some((arg) => /^(deploy|create|update)$/.test(arg))
				? deploy
				: null;
		case "gsutil":
			return /^(rm|rb)$/.test(verb) ? destroy : null;
		case "ansible-playbook":
			return deploy;
		case "nixos-rebuild":
		case "darwin-rebuild":
			return verb === "switch" ? deploy : null;
		case "nh":
			return second === "switch" ? deploy : null;
		case "make":
			return /^deploy\b/.test(verb) ? deploy : null;
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			if (/^(un)?publish$/.test(verb)) return "Publish a package";
			return verb === "run" && /^deploy(:prod.*)?$/.test(second)
				? deploy
				: null;
		case "cargo":
			return verb === "publish" ? "Publish a package" : null;
		case "twine":
			return verb === "upload" ? "Publish a package" : null;
		case "docker":
			if (verb === "push") return "Publish a container image";
			return verb === "volume" && second === "rm" ? destroy : null;
		default:
			return null;
	}
};

const databaseClients =
	/^(psql|mysql|mongosh|bq|snowsql|clickhouse-client|redis-cli)$/;
const destructiveSql =
	/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE|DELETE\s+FROM|dropDatabase|FLUSHALL|FLUSHDB)\b/i;

const ghEffect = (argv: readonly string[]): string | null => {
	const args = subcommand(argv);
	const [group = "", verb = ""] = args;
	if (dryRun(args)) return null;
	if (group === "pr" && verb === "merge") return "Merge a pull request";
	if (group === "pr" && verb === "review" && args.includes("--approve")) {
		return "Approve a pull request";
	}
	if (group === "repo" && verb === "delete") return "Delete a repository";
	if (
		group === "repo" &&
		verb === "edit" &&
		args.some((arg) => /visibility/.test(arg))
	) {
		return access;
	}
	if (group === "release" && verb === "create") return "Publish a release";
	if (group === "gist" && verb === "create") return "Publish a gist";
	if (
		group === "workflow" &&
		verb === "run" &&
		/deploy|release|publish/i.test(args[2] ?? "")
	) {
		return deploy;
	}
	if (
		/^(secret|ssh-key|gpg-key)$/.test(group) &&
		/^(set|delete|remove|add)$/.test(verb)
	) {
		return access;
	}
	if (group === "auth" && /^(login|logout|refresh)$/.test(verb)) return access;
	if (group !== "api") return null;
	const method = args.findIndex((arg) => arg === "-X" || arg === "--method");
	const named = (args[method + 1] ?? "").toUpperCase();
	const written = method !== -1 && /^(PUT|PATCH|DELETE)$/.test(named);
	const path = args.join(" ");
	if (/mergePullRequest|\/merges\b/.test(path)) return "Merge a pull request";
	if (written && /\/merge\b/.test(path)) return "Merge a pull request";
	if (
		written &&
		/collaborators|protection|permissions|private|visibility/.test(path)
	) {
		return access;
	}
	return named === "DELETE" ? "Delete on GitHub" : null;
};

const accessCommands =
	/^(passwd|chpasswd|visudo|dscl|dseditgroup|sysadminctl|useradd|usermod|userdel|csrutil|tccutil)$/;

const segmentEffect = (raw: readonly string[]): string | null => {
	const argv = unwrapped(raw);
	const [tool = "", ...rest] = argv;
	if (tool === "" || textOnly.has(tool)) return null;
	if (/^(bash|sh|zsh|dash)$/.test(tool)) {
		const at = rest.indexOf("-c");
		return at === -1 ? null : bashEffect(rest[at + 1] ?? "");
	}
	if (tool === "eval") return bashEffect(rest.join(" "));
	if (tool === "ssh") {
		const remote = subcommand(argv).slice(1);
		return remote.length > 0 ? bashEffect(remote.join(" ")) : null;
	}
	if (tool === "git") {
		const args = subcommand(argv);
		if (gitText.has(args[0] ?? "")) return null;
		return args[0] === "push" ? gitPush(args) : null;
	}
	if (tool === "gh") return ghEffect(argv);
	if (databaseClients.test(tool)) {
		return !loopback(rest) && rest.some((word) => destructiveSql.test(word))
			? destroy
			: null;
	}
	if (/^(sendmail|mutt|msmtp|swaks|mail|mailx)$/.test(tool)) return send;
	if (tool === "osascript" && /\bsend\b/.test(rest.join(" "))) return send;
	if (tool === "stripe" && rest.includes("create")) return "Spend money";
	if (accessCommands.test(tool)) return access;
	if (
		tool === "security" &&
		/^(find-(generic|internet)-password|dump-keychain)$/.test(rest[0] ?? "")
	) {
		return "Read a secret from the keychain";
	}
	if (
		/^(ufw|iptables|nft|pfctl|fdesetup|spctl)$/.test(tool) &&
		rest.some((word) => /^(disable|-F|flush|-d|--master-disable)$/.test(word))
	) {
		return access;
	}
	if (!dryRun(rest)) {
		const effect = toolEffect(tool, subcommand(argv));
		if (effect) return effect;
	}
	if (/^(curl|wget|http|https|xh)$/.test(tool) && !loopback(rest)) {
		if (rest.some((word) => sendHosts.test(word))) return send;
		if (rest.some((word) => /api\.stripe\.com/.test(word))) {
			return "Spend money";
		}
		if (uploaded(rest).some((path) => secretFile.test(path))) {
			return secretLeaves;
		}
	}
	if (/^(scp|rsync|sftp)$/.test(tool)) {
		const paths = rest.filter(
			(word, at) =>
				!word.startsWith("-") && !/^--exclude/.test(rest[at - 1] ?? ""),
		);
		if (
			paths
				.slice(0, -1)
				.some((path) => secretFile.test(path.replace(/\/$/, "")))
		) {
			return secretLeaves;
		}
	}
	return null;
};

const bashEffect = (command: string): string | null => {
	const segments = segmentsOf(command);
	const tools = segments.map((argv) => unwrapped(argv)[0] ?? "");
	if (
		segments.some(
			(argv) =>
				argv.length === 1 && /^(env|printenv)$/.test(baseName(argv[0] ?? "")),
		) &&
		tools.some((tool) => /^(curl|wget|nc|ncat|http|xh)$/.test(tool))
	) {
		return secretLeaves;
	}
	for (const argv of segments) {
		const effect = segmentEffect(argv);
		if (effect) return effect;
	}
	return null;
};

const mainBranch = (input: Record<string, unknown>) =>
	typeof input.branch === "string" &&
	/^(refs\/heads\/)?(main|master)$/.test(input.branch);

const readVerb =
	/^(get|list|read|search|check|find|fetch|describe|view|show|run_secret_scanning)(_|$)/;
const sendServer =
	/gmail|outlook|mail|slack|messenger|whatsapp|imessage|sms|twilio|discord|telegram|twitter|bluesky|mastodon|linkedin|threads/i;
const sendVerb =
	/(^|_)(send|post|reply|forward|schedule|publish|tweet|create_post|draft_and_send)(_|$)/;
const payVerb =
	/(^|_)(pay|payment|purchase|buy|place_order|create_order|refund|invoice|payout|transfer|charge|request_ride|checkout_session)(_|$)/;
const destroyVerb =
	/(^|_)(delete|destroy|drop|remove|purge|trash|batch_delete)(_|$)/;
const deployVerb = /(^|_)(deploy|apply_migration|publish)(_|$)|deploy-site/;
const secretServer = /1password|bitwarden|vault|keychain/i;
const accessVerb =
	/(^|_)(secrets?|credentials?|permissions?|collaborators?|roles?|groups?|share|add_user|remove_user|update_user|grant|revoke|invite)(_|$)/;

const commandInputs = (input: Record<string, unknown>) =>
	["command", "cli_command", "sql", "query"].flatMap((key) => {
		const value = input[key];
		return typeof value === "string" ? [value] : [];
	});

const mcpEffect = (
	toolName: string,
	input: Record<string, unknown>,
): string | null => {
	const [, server = "", ...parts] = toolName.split("__");
	const tool = parts.join("__");
	for (const command of commandInputs(input)) {
		if (destructiveSql.test(command)) return destroy;
		const effect = bashEffect(command);
		if (effect) return effect;
	}
	if (/merge_pull_request|enable_pr_auto_merge/.test(tool)) {
		return "Merge a pull request";
	}
	if (
		/pull_request_review/.test(tool) &&
		/APPROVE/i.test(String(input.event ?? ""))
	) {
		return "Approve a pull request";
	}
	if (
		/create_or_update_file|push_files|delete_file/.test(tool) &&
		mainBranch(input)
	) {
		return "Write main on GitHub without review";
	}
	if (
		/actions_run_trigger|run_workflow/.test(tool) &&
		/deploy|release|publish/i.test(JSON.stringify(input))
	) {
		return deploy;
	}
	if (secretServer.test(server) && !/^list/.test(tool)) {
		return "Read a secret from a password manager";
	}
	if (readVerb.test(tool) || readVerb.test(tool.replace(/^[a-z0-9]+_/, ""))) {
		return null;
	}
	if (payVerb.test(tool)) return `Spend money through ${tool}`;
	if (sendServer.test(server) && sendVerb.test(tool)) {
		return `Send as Aaron through ${tool}`;
	}
	if (
		/calendar/i.test(server) &&
		/create|update/.test(tool) &&
		Array.isArray(input.attendees) &&
		input.attendees.length > 0
	) {
		return `Send as Aaron through ${tool}`;
	}
	if (accessVerb.test(tool)) return access;
	if (server === "github") {
		return /delete_repository/.test(tool) ? "Delete a repository" : null;
	}
	if (destroyVerb.test(tool)) return `Delete through ${tool}`;
	if (deployVerb.test(tool)) return `Deploy through ${tool}`;
	return null;
};

/**
 * The serious effect a cloud session's permission prompt would have, in one
 * line for Aaron, or null when it is harmless.
 */
export const seriousEffect = (
	toolName: string,
	input: Record<string, unknown>,
): string | null => {
	if (toolName === "Bash") {
		return typeof input.command === "string" ? bashEffect(input.command) : null;
	}
	if (toolName.startsWith(remotePrefix)) {
		return accessRemote.has(toolName.slice(remotePrefix.length))
			? access
			: null;
	}
	return toolName.startsWith("mcp__") ? mcpEffect(toolName, input) : null;
};
