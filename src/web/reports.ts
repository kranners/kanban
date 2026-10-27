import { signal } from "@preact/signals";
import type { ReportResult } from "../shared/types.ts";
import { errorOf } from "./exits.ts";

export type ReportState =
	| { phase: "asking" }
	| { phase: "failed"; error: string };

const noticeMs = 15_000;
const answerMs = 10 * 60_000;

export const reports = signal<ReadonlyMap<string, ReportState>>(new Map());

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function setReport(id: string, state: ReportState | null): void {
	clearTimeout(timers.get(id));
	timers.delete(id);
	const next = new Map(reports.peek());
	if (state) next.set(id, state);
	else next.delete(id);
	reports.value = next;
	if (!state) return;
	timers.set(
		id,
		setTimeout(
			() =>
				state.phase === "asking"
					? setReport(id, {
							phase: "failed",
							error: "The board server never said how the report went",
						})
					: setReport(id, null),
			state.phase === "asking" ? answerMs : noticeMs,
		),
	);
}

export const regionReportKey = (regionId: string): string =>
	`region:${regionId}`;

export function receiveReport(key: string, result: ReportResult): void {
	if (reports.peek().get(key)?.phase !== "asking") return;
	setReport(key, result.ok ? null : { phase: "failed", error: result.error });
}

export function forgetAskingReports(): void {
	for (const [key, state] of reports.peek()) {
		if (state.phase === "asking") setReport(key, null);
	}
}

export function dismissReport(key: string): void {
	if (reports.peek().get(key)?.phase === "failed") setReport(key, null);
}

async function ask(key: string, path: string): Promise<void> {
	if (reports.peek().get(key)?.phase === "asking") return;
	setReport(key, { phase: "asking" });
	try {
		const response = await fetch(path, { method: "POST" });
		if (response.status !== 202 && response.status !== 409) {
			setReport(key, { phase: "failed", error: await errorOf(response) });
		}
	} catch (caught) {
		setReport(key, {
			phase: "failed",
			error: `Couldn't reach the board server (${caught})`,
		});
	}
}

export function requestReport(sessionId: string): Promise<void> {
	return ask(
		sessionId,
		`/api/sessions/${encodeURIComponent(sessionId)}/report`,
	);
}

export function requestRegionReport(regionId: string): Promise<void> {
	return ask(
		regionReportKey(regionId),
		`/api/regions/${encodeURIComponent(regionId)}/report`,
	);
}
