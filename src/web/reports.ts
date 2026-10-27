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

export function receiveReport(id: string, result: ReportResult): void {
	if (reports.peek().get(id)?.phase !== "asking") return;
	setReport(id, result.ok ? null : { phase: "failed", error: result.error });
}

export function dismissReport(id: string): void {
	if (reports.peek().get(id)?.phase === "failed") setReport(id, null);
}

export async function requestReport(id: string): Promise<void> {
	if (reports.peek().get(id)?.phase === "asking") return;
	setReport(id, { phase: "asking" });
	try {
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(id)}/report`,
			{ method: "POST" },
		);
		if (response.status !== 202 && response.status !== 409) {
			setReport(id, { phase: "failed", error: await errorOf(response) });
		}
	} catch (caught) {
		setReport(id, {
			phase: "failed",
			error: `Couldn't reach the board server (${caught})`,
		});
	}
}
