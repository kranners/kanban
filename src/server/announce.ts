import { maxPromptText } from "../shared/conversation.ts";
import type { Board, Session } from "../shared/types.ts";
import type { Audit } from "./audit.ts";
import { unsafeTextReason } from "./prompts.ts";

export type AnnounceDelivery = {
	id: string;
	name: string;
	ok: boolean;
	error: string | null;
};

export type AnnounceResult =
	| { ok: true; deliveries: AnnounceDelivery[] }
	| { ok: false; error: string };

export type Announcer = (
	text: string,
	identity: string | null,
) => Promise<AnnounceResult>;

export type AnnounceDeps = {
	board(): Board;
	prompt(
		session: Session,
		text: string,
	): Promise<{ ok: true } | { ok: false; error: string }>;
	audit: Audit;
};

const gone = new Set<Session["activity"]>(["stopped", "failed"]);

export const announceRefusal = (text: string): string | null => {
	if (text.trim() === "") return "Type something to announce";
	if (text.length > maxPromptText) {
		return `An announcement can be at most ${maxPromptText} characters`;
	}
	return unsafeTextReason(text);
};

export const announceTargets = (board: Board): Session[] =>
	board.sessions.filter((session) => !gone.has(session.activity));

export const skipReason = (session: Session): string | null => {
	if (session.activity === "needs-you") {
		return "Waiting on a question or permission prompt, so typing would answer it";
	}
	if (session.cloud) return null;
	if (session.kind === "background") {
		return session.attachable && session.short
			? null
			: "This background session cannot be attached";
	}
	return session.cmux ? null : "Not in a cmux pane, so it can only be read";
};

export const describeDeliveries = (deliveries: AnnounceDelivery[]): string => {
	const sent = deliveries.filter((delivery) => delivery.ok);
	const missed = deliveries.filter((delivery) => !delivery.ok);
	const head = `Announced to ${sent.length} of ${deliveries.length} session${deliveries.length === 1 ? "" : "s"}`;
	return [
		head,
		...missed.map((delivery) => `- ${delivery.name}: ${delivery.error}`),
	].join("\n");
};

export const createAnnouncer =
	(deps: AnnounceDeps): Announcer =>
	async (text, identity) => {
		const refused = announceRefusal(text);
		if (refused) return { ok: false, error: refused };
		const targets = announceTargets(deps.board());
		if (targets.length === 0) {
			return { ok: false, error: "There are no live sessions to announce to" };
		}
		const deliveries = await Promise.all(
			targets.map(async (session): Promise<AnnounceDelivery> => {
				const skipped = skipReason(session);
				const outcome = skipped
					? { ok: false as const, error: skipped }
					: await deps.prompt(session, text).catch((error: unknown) => ({
							ok: false as const,
							error: (error as Error).message || "Sending failed",
						}));
				deps.audit({
					action: "announce",
					sessionId: session.id,
					chars: text.length,
					identity,
					result: outcome.ok ? "sent" : `error: ${outcome.error}`,
				});
				return {
					id: session.id,
					name: session.name,
					ok: outcome.ok,
					error: outcome.ok ? null : outcome.error,
				};
			}),
		);
		return { ok: true, deliveries };
	};
