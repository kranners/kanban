import { Bot, Hourglass } from "lucide-preact";
import type { JSX } from "preact";
import { outstandingSubagents } from "../shared/subagents.ts";
import { activityOrder } from "../shared/types.ts";
import { ActivityIcon, activityLabel } from "./activity.tsx";
import {
	activityCounts,
	activityFilter,
	subagentTotals,
	toggleActivity,
	workingSubagentsOnly,
} from "./state.ts";
import { subagentSummary } from "./subagentCounts.ts";

export function StatusView(): JSX.Element {
	const counts = activityCounts.value;
	const present = activityOrder.filter((a) => (counts.get(a) ?? 0) > 0);
	return (
		<div class="status-view">
			<h3 class="rail-section">Sessions</h3>
			{present.length === 0 ? (
				<p class="rail-empty">No sessions on the board.</p>
			) : (
				<ul class="status-rows">
					{present.map((a) => (
						<li key={a}>
							<button
								type="button"
								class={`status-row act-${a}`}
								aria-pressed={activityFilter.value.has(a)}
								title={`Show only ${activityLabel[a].toLowerCase()}`}
								onClick={() => toggleActivity(a)}
							>
								<ActivityIcon activity={a} size={12} />
								<span class="status-label">{activityLabel[a]}</span>
								<span class="num">{counts.get(a)}</span>
							</button>
						</li>
					))}
				</ul>
			)}
			<SubagentStatus />
		</div>
	);
}

function SubagentStatus(): JSX.Element | null {
	const counts = subagentTotals.value;
	if (counts.working + counts.idle + counts.done === 0) return null;
	const pressed = workingSubagentsOnly.value;
	const outstanding = outstandingSubagents(counts);
	return (
		<>
			<h3 class="rail-section">Subagents</h3>
			<ul class="status-rows">
				{counts.working > 0 && (
					<li class="status-row act-working">
						<ActivityIcon activity="working" size={12} />
						<span class="status-label">Running</span>
						<span class="num">{counts.working}</span>
					</li>
				)}
				{outstanding > 0 && (
					<li class="status-row subagent-waiting">
						<Hourglass size={12} strokeWidth={2.25} aria-hidden="true" />
						<span class="status-label">Waiting on</span>
						<span class="num">{outstanding}</span>
					</li>
				)}
				{counts.done > 0 && (
					<li class="status-row act-done">
						<ActivityIcon activity="done" size={12} />
						<span class="status-label">Done</span>
						<span class="num">{counts.done}</span>
					</li>
				)}
				<li>
					<button
						type="button"
						class="status-row"
						aria-pressed={pressed}
						title={subagentSummary(counts)}
						onClick={() => {
							workingSubagentsOnly.value = !pressed;
						}}
					>
						<Bot size={12} aria-hidden="true" />
						<span class="status-label">Highlight working subagents</span>
					</button>
				</li>
			</ul>
		</>
	);
}
