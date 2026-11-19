import type { ButlerThreadKind } from "../shared/types.ts";

/** What each kind of Butler thread is called. */
export const threadKindLabels: Record<ButlerThreadKind, string> = {
	conversation: "Conversation",
	dm: "DM",
	board: "Board",
	job: "Job",
	desk: "Desk session",
	scheduled: "Scheduled",
	voice: "Voice",
};
