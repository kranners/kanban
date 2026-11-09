import { isAbsolute, normalize, resolve, sep } from "node:path";

// The serious set: the effects that still need Aaron, judged by what a
// prompt does, never by how. Everything else a session asks for is harmless
// and the board allows it at once.

const remotePrefix = "mcp__claude-code-remote__";

const accessRemote = new Set([
	"create_environment",
	"update_environment",
	"switch_environment",
	"request_credential",
	"request_computer_folder",
	"confirm_repository_trust",
]);

const sendTool =
	/gmail|outlook|mail|slack|messenger|whatsapp|imessage|sms|twilio|discord|tweet|linkedin/i;
const sendVerb = /send|post|reply|publish|draft_and_send|chat_post/i;
const payTool = /pay|purchase|checkout|stripe|order_place|place_order|buy/i;

const shellSplit = /&&|\|\||[;|\n]/;

const scratchRoots = ["/tmp", "/private/tmp", "/var/folders"];

const inside = (path: string, root: string) =>
	path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const words = (segment: string) =>
	segment
		.trim()
		.split(/\s+/)
		.map((word) => word.replace(/^['"]|['"]$/g, ""))
		.filter(Boolean);

const unprivileged = (argv: string[]) => {
	const rest = [...argv];
	while (
		rest.length > 0 &&
		/^(sudo|doas|env|nohup|time|command|exec|butler-root|[A-Z_]+=.*)$/.test(
			rest[0] ?? "",
		)
	) {
		rest.shift();
		while ((rest[0] ?? "").startsWith("-")) rest.shift();
	}
	return rest;
};

const secretPath =
	/(^|[\s/@=:'"])(\.env(\.[\w-]+)?|\.ssh\/|id_(rsa|ed25519|ecdsa)|[\w.-]+\.(pem|key|p12)|\.aws\/credentials|\.netrc|credentials\.json)\b/i;

const offMachine = /^(curl|wget|scp|rsync|nc|ncat|sftp|ftp|http|https|xh)$/;

const deletesRemotely =
	/\b(aws\s+s3\s+(rm|rb)|aws\s+\S+\s+delete-|gcloud\s+.*\bdelete\b|gsutil\s+(rm|rb)|kubectl\s+delete|helm\s+(uninstall|delete)|terraform\s+destroy|(psql|mysql|mongosh|bq|snowsql|clickhouse-client)\b.*\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE|DELETE\s+FROM|dropDatabase))\b/i;

const changesProduction =
	/\b(terraform\s+apply|tofu\s+apply|pulumi\s+up|kubectl\s+(apply|rollout|scale|set|patch|replace|edit)|helm\s+(install|upgrade)|cdk\s+deploy|sst\s+deploy|serverless\s+deploy|sls\s+deploy|fly\s+deploy|vercel\s+(--prod|deploy\s+--prod)|netlify\s+deploy\s+--prod|wrangler\s+(deploy|publish)|aws\s+\S+\s+(create|put|update|modify|run|start|stop|terminate)-|gcloud\s+.*\b(deploy|create|update)\b|(npm|pnpm|yarn|bun)\s+run\s+deploy[\w:-]*)\b/i;

const sendsAsAaron =
	/\b(sendmail|mutt|msmtp|mail\s+-s|hooks\.slack\.com|slack\.com\/api\/chat\.|api\.sendgrid\.com|api\.mailgun\.net|api\.twilio\.com|api\.postmarkapp\.com|graph\.facebook\.com)\b/i;

const spends =
	/\b(api\.stripe\.com|stripe\s+(charges|payment_intents|checkout)\s+create)\b/i;

const securityChange =
	/\b(passwd|chpasswd|visudo|dscl|dseditgroup|sysadminctl|useradd|usermod|userdel|csrutil|fdesetup\s+disable|spctl\s+--master-disable|pfctl\s+-d|tccutil|gh\s+auth\s+(login|logout|refresh|token)|gh\s+secret\s+(set|delete|remove)|gh\s+ssh-key\s+(add|delete)|security\s+(add|delete|set)-)\b|\/etc\/sudoers|authorized_keys/i;

const readsKeychain =
	/\bsecurity\s+(find-(generic|internet)-password\s.*-[wg]\b|dump-keychain)/i;

const gitPush = (argv: string[]): string | null => {
	const at = argv.indexOf("push");
	if (argv[0] !== "git" || at === -1) return null;
	const args = argv.slice(at + 1);
	if (
		args.some(
			(arg) =>
				arg === "-f" ||
				arg.startsWith("--force") ||
				(arg.startsWith("+") && arg.length > 1),
		)
	) {
		return "Force push";
	}
	const refs = args.filter((arg) => !arg.startsWith("-")).slice(1);
	if (refs.some((ref) => /(^|:)(refs\/heads\/)?(main|master)$/.test(ref))) {
		return "Push to main without review";
	}
	return null;
};

const deletesLocally = (argv: string[], cwd: string | undefined) => {
	if (cwd === undefined || argv[0] !== "rm") return null;
	const paths = argv.slice(1).filter((arg) => !arg.startsWith("-"));
	const home = process.env.HOME ?? "";
	const outside = paths.filter((path) => {
		if (/[$`*~]/.test(path) && !path.startsWith("~/")) return true;
		const full = normalize(
			path.startsWith("~/")
				? resolve(home, path.slice(2))
				: isAbsolute(path)
					? path
					: resolve(cwd, path),
		);
		return ![cwd, ...scratchRoots].some((root) => inside(full, root));
	});
	return outside.length > 0 ? `Delete ${outside.join(", ")}` : null;
};

const bashEffect = (command: string, cwd: string | undefined) => {
	if (deletesRemotely.test(command)) {
		return "Delete production data or cloud resources";
	}
	if (changesProduction.test(command)) return "Deploy or change production";
	if (sendsAsAaron.test(command)) return "Send a message as Aaron";
	if (spends.test(command)) return "Spend money";
	if (securityChange.test(command)) {
		return "Change an account, access or security setting";
	}
	if (readsKeychain.test(command)) return "Read a secret from the keychain";
	const segments = command.split(shellSplit).map(words);
	if (
		segments.some((argv) => offMachine.test(unprivileged(argv)[0] ?? "")) &&
		secretPath.test(command)
	) {
		return "Send a secret off the machine";
	}
	for (const segment of segments) {
		const argv = unprivileged(segment);
		if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
			return "Merge a pull request";
		}
		if (argv[0] === "gh" && argv[1] === "repo" && argv[2] === "delete") {
			return "Delete a repository";
		}
		const pushed = gitPush(argv);
		if (pushed) return pushed;
		const deleted = deletesLocally(argv, cwd);
		if (deleted) return deleted;
	}
	return null;
};

const mainBranch = (input: Record<string, unknown>) =>
	typeof input.branch === "string" && /^(main|master)$/.test(input.branch);

/**
 * The serious effect a permission prompt would have, in one line for Aaron,
 * or null when it is harmless. cwd is the folder a local session works in;
 * a cloud session's container is scratch, so it has none.
 */
export const seriousEffect = (
	toolName: string,
	input: Record<string, unknown>,
	cwd?: string,
): string | null => {
	if (toolName === "Bash") {
		return typeof input.command === "string"
			? bashEffect(input.command, cwd)
			: null;
	}
	if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) {
		const path = String(input.file_path ?? input.notebook_path ?? "");
		return /authorized_keys|\/etc\/sudoers|\/etc\/pam\.d/.test(path)
			? "Change an account, access or security setting"
			: null;
	}
	if (toolName.startsWith(remotePrefix)) {
		const tool = toolName.slice(remotePrefix.length);
		return accessRemote.has(tool)
			? "Change an account, access or security setting"
			: null;
	}
	if (!toolName.startsWith("mcp__")) return null;
	const tool = toolName.split("__").slice(2).join("__");
	if (/merge_pull_request|enable_pr_auto_merge/.test(tool)) {
		return "Merge a pull request";
	}
	if (
		/create_or_update_file|push_files|delete_file/.test(tool) &&
		mainBranch(input)
	) {
		return "Write main on GitHub without review";
	}
	if (/delete_repository|delete_repo/.test(tool)) return "Delete a repository";
	if (
		/secret|credential|permission|collaborator/.test(tool) &&
		!/^(get|list|read)/.test(tool)
	) {
		return "Change an account, access or security setting";
	}
	if (payTool.test(tool)) return `Spend money through ${tool}`;
	if (sendTool.test(toolName) && sendVerb.test(tool)) {
		return `Send as Aaron through ${tool}`;
	}
	return null;
};
