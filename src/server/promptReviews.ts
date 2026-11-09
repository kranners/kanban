// Butler's reviewer for claude.ai's session tools: spike's
// butler-kanban-reviewer reads the open prompts of this family with
// pending_reviews, within seconds of each appearing, judges each with one
// quick model call against what the session is doing, and answers with
// review_prompt. Only prompts the fixed safe set already allows are ever
// handed to it, so the reviewer can only hold back what the safe set would
// approve, never approve anything more. A prompt it holds stays Aaron's,
// with its one-line reason on the card; while one is being reviewed the safe
// sweep leaves it alone, and once a review has not answered within
// reviewWindowMs, or the reviewer says it is unavailable, the fixed safe set
// takes it again.

/** claude.ai's session tools whose every prompt Butler's reviewer judges, never granted for the rest of a session. */
export const reviewedRemote: ReadonlySet<string> = new Set([
	"create_session",
	"send_message",
	"send_later",
	"set_session_title",
	"set_session_tags",
	"add_repo",
]);

const remotePrefix = "mcp__claude-code-remote__";

/** Reads of claude.ai's session tools, which the reviewer approves without a model call. */
const remoteRead = /^(get|list|read)_[a-z_]+$/;

/** The reviewer's family, by full tool name: the six above and claude.ai's own reads. */
export const reviewKind = (toolName: string): "reviewed" | "read" | null => {
	if (!toolName.startsWith(remotePrefix)) return null;
	const tool = toolName.slice(remotePrefix.length);
	if (reviewedRemote.has(tool)) return "reviewed";
	return remoteRead.test(tool) ? "read" : null;
};

/** How long a prompt handed to the reviewer stays out of the sweep's reach. */
export const reviewWindowMs = 90_000;
/** How long a hold is remembered after it was made, well past any prompt's life. */
const heldForMs = 7 * 24 * 60 * 60_000;

type Review =
	| { state: "reviewing"; at: number }
	| { state: "held"; at: number; reason: string };

export type PromptReviews = {
	/** Marks a prompt as in review; false when it is already in review or held. */
	claim(requestId: string): boolean;
	/** Keeps a prompt for Aaron, with the reviewer's one-line reason. */
	hold(requestId: string, reason: string): void;
	/** Hands a prompt back to the fixed safe set. */
	release(requestId: string): void;
	/** The reviewer's reason when it held the prompt. */
	held(requestId: string): string | null;
	/** Whether the reviewer is judging it now. */
	reviewing(requestId: string): boolean;
};

export const createPromptReviews = (
	now: () => number = Date.now,
): PromptReviews => {
	const reviews = new Map<string, Review>();
	const current = (requestId: string): Review | undefined => {
		const review = reviews.get(requestId);
		if (!review) return undefined;
		const age = now() - review.at;
		if (
			(review.state === "reviewing" && age > reviewWindowMs) ||
			(review.state === "held" && age > heldForMs)
		) {
			reviews.delete(requestId);
			return undefined;
		}
		return review;
	};
	return {
		claim(requestId) {
			if (current(requestId)) return false;
			reviews.set(requestId, { state: "reviewing", at: now() });
			return true;
		},
		hold(requestId, reason) {
			reviews.set(requestId, {
				state: "held",
				at: now(),
				reason:
					reason.replace(/\s+/g, " ").trim().slice(0, 200) || "no reason given",
			});
		},
		release(requestId) {
			reviews.delete(requestId);
		},
		held(requestId) {
			const review = current(requestId);
			return review?.state === "held" ? review.reason : null;
		},
		reviewing(requestId) {
			return current(requestId)?.state === "reviewing";
		},
	};
};

/** The board's one store, shared by its tools and its cloud cards. */
export const promptReviews = createPromptReviews();
