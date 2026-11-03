import { signal } from "@preact/signals";
import {
	type Annotation,
	type Annotations,
	type ButlerCard,
	type ButlerPresence,
	butlerPresenceMs,
} from "../shared/types.ts";

export const butlerPresence = signal<ButlerPresence>({
	presence: null,
	watching: [],
});

export const isButlerCard = (a: Annotation | undefined): a is ButlerCard =>
	a?.kind === "butler-card";

/**
 * Where Butler's cursor sits: on what he last acted on, for two minutes,
 * and otherwise on the self-fix he has running, newest first.
 */
export function presenceOf(
	presence: ButlerPresence,
	annotations: Annotations,
	now: number,
): { target: string; label: string } | null {
	const explicit = presence.presence;
	if (explicit && now - explicit.at < butlerPresenceMs) {
		const card = annotations[explicit.target];
		const label =
			explicit.label === "Butler" && isButlerCard(card) && card.selfFix
				? "Butler (self-fix)"
				: explicit.label;
		return { target: explicit.target, label };
	}
	const running = Object.values(annotations)
		.filter(
			(a): a is ButlerCard =>
				isButlerCard(a) && a.selfFix !== undefined && a.state === "working",
		)
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];
	return running ? { target: running.id, label: "Butler (self-fix)" } : null;
}
