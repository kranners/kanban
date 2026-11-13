// claude.ai's session tools that spawn, message, title or tag sessions or
// add a repository. The safe set allows them, but each prompt is judged on
// its own, never granted for the rest of a session, and the board's one
// decision path holds any that asks for secrets, a force push or wider
// permissions, or that messages a session not on the board.

/** claude.ai's session tools whose every prompt is judged alone, never granted for the rest of a session. */
export const reviewedRemote: ReadonlySet<string> = new Set([
	"create_session",
	"send_message",
	"send_later",
	"set_session_title",
	"set_session_tags",
	"add_repo",
]);

const remotePrefix = "mcp__claude-code-remote__";

const redFlags: readonly [RegExp, string][] = [
	[
		/\b(passwords?|passwd|api[ _-]?keys?|secret keys?|access keys?|private keys?|ssh keys?|credentials?|(?:api|access|auth|bearer|github|oauth|session) tokens?|\.env\b|one[- ]time code|2fa code|otp)\b/i,
		"asks for credentials or secrets",
	],
	[/(push\s+(-f\b|--force)|force[- ]push)/i, "asks for a force push"],
	[
		/(bypasspermissions|dangerously[- ]skip|skip[- ]permissions|--permission-mode|\bsudo\b)/i,
		"asks to widen permissions",
	],
];

const targetFields = [
	"session_id",
	"persistent_session_id",
	"target_session_id",
];

/**
 * Why a prompt of one of those tools stays Aaron's although the safe set
 * allows it, or null when nothing about it does.
 */
export const reviewedHold = (
	toolName: string,
	input: Record<string, unknown>,
	onBoard: (id: string) => boolean,
): string | null => {
	if (!toolName.startsWith(remotePrefix)) return null;
	if (!reviewedRemote.has(toolName.slice(remotePrefix.length))) return null;
	const text = JSON.stringify(input);
	for (const [pattern, reason] of redFlags) {
		if (pattern.test(text)) return reason;
	}
	for (const field of targetFields) {
		const target = input[field];
		if (typeof target === "string" && target !== "" && !onBoard(target)) {
			return "sends to a session that is not on the board";
		}
	}
	return null;
};
