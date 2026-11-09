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

export type CriticalItem = {
	glyph: string;
	capability: string;
	touches: string;
};

/** A request's card as its sections, read from the Discord Markdown the daemon rendered. */
export type ApprovalSections = {
	goal: string | null;
	critical: CriticalItem[];
	/** True when its Needs your approval says it has no critical permission. */
	noCritical: boolean;
	included: string[];
	limits: string[];
	/** Anything outside those sections, such as a call's own description. */
	other: string[];
};

/** Discord Markdown's escapes, bold and code marks taken off, for plain text. */
export const plain = (line: string): string =>
	line
		.replace(/\\([\\`*_~|>#[\]()-])/g, "$1")
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/<#([0-9]{5,25})>/g, "#$1")
		.trim();

export function parseApprovalBody(body: string | undefined): ApprovalSections {
	const out: ApprovalSections = {
		goal: null,
		critical: [],
		noCritical: false,
		included: [],
		limits: [],
		other: [],
	};
	let section: "other" | "critical" | "included" | "limits" = "other";
	for (const raw of (body ?? "").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,3}\s+(.*)$/.exec(line)?.[1];
		if (heading !== undefined) {
			if (/Needs your approval$/u.test(heading)) section = "critical";
			else if (/^Also included$/.test(heading)) section = "included";
			else if (/^Limits$/.test(heading)) section = "limits";
			else out.other.push(plain(heading));
			continue;
		}
		const goal = /^\*\*Goal:\*\*\s*(.*)$/.exec(line)?.[1];
		if (goal !== undefined && out.goal === null) {
			out.goal = plain(goal);
			continue;
		}
		if (section === "critical") {
			if (/^No critical permissions$/.test(line)) {
				out.noCritical = true;
				continue;
			}
			const small = /^-#\s+(.*)$/.exec(line)?.[1];
			const last = out.critical.at(-1);
			if (small !== undefined && last && !last.touches) {
				last.touches = plain(small);
				continue;
			}
			const point = /^-\s+`([^`]*)`\s+(.*)$/.exec(line);
			if (point) {
				out.critical.push({
					glyph: point[1] ?? "",
					capability: plain(point[2] ?? ""),
					touches: "",
				});
				continue;
			}
		}
		const item = /^-#?\s+(.*)$/.exec(line)?.[1];
		if (item !== undefined && section === "included") {
			out.included.push(plain(item));
			continue;
		}
		if (item !== undefined && section === "limits") {
			out.limits.push(plain(item));
			continue;
		}
		out.other.push(plain(line));
	}
	return out;
}

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

export function approveAll(): Promise<
	Outcome<{
		approved: ButlerWaitingApproval[];
		left: (ButlerWaitingApproval & { why: string })[];
	}>
> {
	return request("POST", "/api/butler/approvals/all", {});
}
