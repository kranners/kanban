import type {
	ButlerCard,
	ButlerCardEvent,
	ButlerCardState,
	Step,
} from "../shared/types.ts";
import type { Lane, Span } from "./timeline.ts";

const stateLabel: Record<ButlerCardState, string> = {
	working: "Working",
	"needs-you": "Needs you",
	idle: "Idle",
	done: "Done",
	failed: "Failed",
};

/** States that run until the next one, drawn as bars on the timeline. */
const lasting: ReadonlySet<ButlerCardState> = new Set(["working", "needs-you"]);

/** The card's history, or for a card from before timelines, its last update. */
export function historyOf(card: ButlerCard): ButlerCardEvent[] {
	if (card.history && card.history.length > 0) return card.history;
	return [
		{
			at: card.updatedAt,
			state: card.state,
			...(card.status === undefined ? {} : { status: card.status }),
		},
	];
}

function eventText(event: ButlerCardEvent): string {
	const label = stateLabel[event.state];
	return event.status ? `${label}: ${event.status}` : label;
}

/**
 * A Butler card's timeline, as a session card's near view draws one: a lane
 * of the stretches it spent working or waiting on Aaron, the last one still
 * running if it is, and a lane of each change of state and status.
 */
export function butlerLanes(card: ButlerCard, now: number): Lane[] {
	const history = historyOf(card);
	const spans: Span[] = history.flatMap((event, index) => {
		if (!lasting.has(event.state)) return [];
		const next = history[index + 1];
		return [
			{
				start: event.at,
				end: next ? next.at : Math.max(event.at, now),
				kind: next ? "done" : "active",
				title: eventText(event),
			},
		];
	});
	const steps: Step[] = history.map((event) => ({
		at: event.at,
		text: eventText(event),
	}));
	return [
		...(spans.length > 0
			? [{ key: "work", label: "Work", spans, finish: null, events: [] }]
			: []),
		{ key: "steps", label: "Steps", spans: [], finish: null, events: steps },
	];
}
