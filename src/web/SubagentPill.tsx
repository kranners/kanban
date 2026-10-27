import { Bot, Hourglass } from "lucide-preact";
import { outstandingSubagents } from "../shared/subagents.ts";
import { ActivityIcon } from "./activity.tsx";
import { subagentTotals, workingSubagentsOnly } from "./state.ts";
import { subagentSummary } from "./subagentCounts.ts";

export function SubagentPill() {
	const counts = subagentTotals.value;
	const pressed = workingSubagentsOnly.value;
	if (counts.working + counts.idle + counts.done === 0) return null;
	const outstanding = outstandingSubagents(counts);
	const action = pressed ? "show everything" : "highlight working subagents";
	const summary = subagentSummary(counts);
	return (
		<>
			<span class="pill-divider" aria-hidden="true" />
			<button
				type="button"
				class="pill subagent-pill"
				aria-pressed={pressed}
				aria-label={`${summary}; ${action}`}
				title={`${summary}. Click to ${action}.`}
				onClick={() => {
					workingSubagentsOnly.value = !pressed;
				}}
			>
				<Bot size={13} aria-hidden="true" />
				{counts.working > 0 && (
					<span class="subagent-count act-working">
						<ActivityIcon activity="working" size={11} />
						<span class="num">{counts.working}</span>
						<span class="pill-label">running</span>
					</span>
				)}
				{outstanding > 0 && (
					<span class="subagent-count subagent-waiting">
						<Hourglass size={11} strokeWidth={2.25} aria-hidden="true" />
						<span class="num">{outstanding}</span>
						<span class="pill-label">waiting on</span>
					</span>
				)}
				{counts.done > 0 && (
					<span class="subagent-count subagent-done act-done">
						<ActivityIcon activity="done" size={11} />
						<span class="num">{counts.done}</span>
					</span>
				)}
			</button>
		</>
	);
}
