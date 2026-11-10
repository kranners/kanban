import { effect } from "@preact/signals";
import { boardBounds, forgetAutoSpots } from "./arrangement.ts";
import { autoLayout } from "./autoLayoutSetting.ts";
import { butlerCards } from "./butlerSubagents.ts";
import { fitBoard, snapping } from "./Canvas.tsx";
import { annotations, board } from "./state.ts";

/** How long after the server answers the page waits for the new layout's frames before framing it. */
const landMs = 500;
/** How long the board keeps teleporting, covering the pages that save the new session spots after it. */
const snapMs = 2500;
/** How long the board must stay unchanged before Auto layout tidies it. */
const autoDelayMs = 2000;

export type TidyAnswer = { ok?: boolean; text?: string; error?: string };

let snapTimer: ReturnType<typeof setTimeout> | undefined;

/** Tidies the board, teleporting everything into place and framing the whole board once it lands. */
export async function tidyBoard(): Promise<TidyAnswer | null> {
	clearTimeout(snapTimer);
	snapping.value = true;
	forgetAutoSpots();
	const response = await fetch("/api/tidy", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ aspect: innerWidth / Math.max(1, innerHeight) }),
	}).catch(() => null);
	const answer = (await response
		?.json()
		.catch(() => null)) as TidyAnswer | null;
	setTimeout(() => {
		const bounds = boardBounds();
		if (answer?.ok && bounds) fitBoard(bounds);
	}, landMs);
	snapTimer = setTimeout(() => {
		snapping.value = false;
	}, snapMs);
	return answer;
}

/** What Auto layout re-tidies for: sessions arriving or leaving, and Butler's cards arriving, leaving or changing state. */
export function layoutKey(): string {
	const sessions = (board.value?.sessions ?? []).map((s) => s.id).sort();
	const cards = butlerCards(annotations.value)
		.map((card) => `${card.id}:${card.state}`)
		.sort();
	return [...sessions, "|", ...cards].join(",");
}

let lastKey: string | null = null;
let autoTimer: ReturnType<typeof setTimeout> | undefined;

effect(() => {
	const on = autoLayout.value;
	const key = layoutKey();
	if (!on || !board.value) {
		clearTimeout(autoTimer);
		lastKey = null;
		return;
	}
	if (key === lastKey) return;
	clearTimeout(autoTimer);
	lastKey = key;
	autoTimer = setTimeout(() => void tidyBoard(), autoDelayMs);
});
