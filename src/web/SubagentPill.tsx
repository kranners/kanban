import { Bot } from "lucide-preact";
import { ActivityIcon } from "./activity.tsx";
import { board, workingSubagentsOnly } from "./state.ts";
import {
	subagentCounts,
	subagentStateOrder,
	subagentSummary,
} from "./subagentCounts.ts";

export function SubagentPill() {
	const counts = subagentCounts(board.value?.subagents ?? []);
	const pressed = workingSubagentsOnly.value;
	if (counts.working + counts.idle + counts.done === 0 && !pressed) return null;
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
				{subagentStateOrder
					.filter((state) => counts[state] > 0)
					.map((state) => (
						<span key={state} class={`subagent-count act-${state}`}>
							<ActivityIcon activity={state} size={11} />
							<span class="num">{counts[state]}</span>
						</span>
					))}
			</button>
		</>
	);
}
