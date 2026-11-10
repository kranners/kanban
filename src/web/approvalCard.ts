import type {
	ButlerThreadApproval,
	ButlerWaitingApproval,
} from "../shared/types.ts";
import { type Outcome, request } from "./comments.ts";

// The page's side of approving Butler's requests from the board, as Aaron
// asked on 6 Nov 2026: each request's card laid out as Discord shows it,
// and the calls behind its Approve and Decline, which the board's server
// sends on to Butler with the nonce only it holds. Nothing typed on the
// board approves anything; only these buttons do.

/** How long Approve must be held on a request with critical items. */
export const holdMs = 1000;

export function fetchApprovals(): Promise<
	Outcome<{ approvals: ButlerWaitingApproval[] }>
> {
	return request("GET", "/api/butler/approvals");
}

export function answerApproval(
	thread: string,
	approval: ButlerThreadApproval,
	decision: "approve" | "decline",
	held: boolean,
): Promise<Outcome<{ ok: true; text: string }>> {
	return request(
		"POST",
		`/api/butler/threads/${encodeURIComponent(thread)}/approvals`,
		{ code: approval.code, decision, held },
	);
}

/** Approve all for exactly the requests the page shows, by code. */
export function approveAll(codes: readonly string[]): Promise<
	Outcome<{
		approved: ButlerWaitingApproval[];
		left: (ButlerWaitingApproval & { why: string })[];
	}>
> {
	return request("POST", "/api/butler/approvals/all", { codes });
}
