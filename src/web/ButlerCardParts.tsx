import type { ButlerCard } from "../shared/types.ts";
import { ButlerCardFootView } from "./butlerCardFace.tsx";
import { linkedCount } from "./butlerThreads.ts";
import { board } from "./state.ts";

export {
	ButlerChips,
	barName,
	CardLink,
	kindOf,
	WatchingMark,
} from "./butlerCardFace.tsx";

export function ButlerSummary(props: { card: ButlerCard }) {
	if (!props.card.summary) return null;
	return (
		<section class="detail-section" aria-label="Summary">
			<div class="detail-head">
				<span>Summary</span>
			</div>
			<p class="butler-near-summary">{props.card.summary}</p>
		</section>
	);
}

export function ButlerCardFoot(props: { card: ButlerCard; now: number }) {
	const { card } = props;
	const linked = card.thread
		? linkedCount(card, board.value?.sessions ?? [])
		: 0;
	return <ButlerCardFootView card={card} linked={linked} now={props.now} />;
}
