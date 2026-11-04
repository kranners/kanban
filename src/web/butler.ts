import { signal } from "@preact/signals";
import {
	type Annotation,
	type Annotations,
	type ButlerCard,
	type ButlerPresence,
	type ButlerSpot,
	butlerPresenceMs,
	type CommentThread,
	noButler,
} from "../shared/types.ts";

export const butlerPresence = signal<ButlerPresence>(noButler);

export const isButlerCard = (a: Annotation | undefined): a is ButlerCard =>
	a?.kind === "butler-card";

export type Spot = { target: string; label: string };

/** Where Butler's face and cursor sit, and whether his face is following Aaron. */
export type Whereabouts = {
	face: Spot | null;
	cursor: Spot | null;
	following: boolean;
};

const changeLabel = "Butler (change)";

/** "Butler" on one of his change cards reads as working on that change. */
const labelled = (spot: ButlerSpot, annotations: Annotations): Spot => {
	const card = annotations[spot.target];
	return {
		target: spot.target,
		label:
			spot.label === "Butler" && isButlerCard(card) && card.selfFix
				? changeLabel
				: spot.label,
	};
};

const fresh = (spot: ButlerSpot | null, now: number): spot is ButlerSpot =>
	spot !== null && now - spot.at < butlerPresenceMs;

/** A card a thread was about, by the id the board has it under, or the thread's own pin. */
const threadSpot = (
	thread: CommentThread,
	annotations: Annotations,
): string => {
	const card = thread.context?.card;
	if (!card) return thread.id;
	if (card.kind === "session") return card.id;
	if (annotations[card.id]) return card.id;
	const change = `self-fix-${card.id}`;
	return annotations[change] ? change : thread.id;
};

/**
 * What Butler is working on: what he last acted on, for two minutes, then
 * a message of Aaron's he is still answering, then his newest running change.
 */
function cursorOf(
	presence: ButlerPresence,
	annotations: Annotations,
	threads: Iterable<CommentThread>,
	now: number,
): Spot | null {
	if (fresh(presence.working, now)) {
		return labelled(presence.working, annotations);
	}
	const answering = [...threads]
		.filter(
			(t) => t.to === "butler" && (t.running || (t.waiting?.length ?? 0) > 0),
		)
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];
	if (answering) {
		return { target: threadSpot(answering, annotations), label: "Butler" };
	}
	const running = Object.values(annotations)
		.filter(
			(a): a is ButlerCard =>
				isButlerCard(a) && a.selfFix !== undefined && a.state === "working",
		)
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];
	return running ? { target: running.id, label: changeLabel } : null;
}

/**
 * Where Butler is: his cursor on what he is working on, and his face on
 * what he last looked at for two minutes, otherwise on what Aaron is
 * working on, otherwise beside his cursor.
 */
export function presenceOf(
	presence: ButlerPresence,
	annotations: Annotations,
	threads: Iterable<CommentThread>,
	now: number,
): Whereabouts {
	const cursor = cursorOf(presence, annotations, threads, now);
	if (fresh(presence.looking, now)) {
		return {
			face: labelled(presence.looking, annotations),
			cursor,
			following: false,
		};
	}
	if (presence.following) {
		return {
			face: { target: presence.following, label: "Butler" },
			cursor,
			following: true,
		};
	}
	return { face: cursor, cursor, following: false };
}
