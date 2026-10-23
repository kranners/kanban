import type { JSX } from "preact";
import type { Activity } from "../../shared/types.ts";

const labels: Record<Activity, string> = {
	working: "Working",
	"needs-you": "Needs you",
	idle: "Idle",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
};

const shapes: Record<Activity, JSX.Element> = {
	working: <circle cx="6" cy="6" r="4" fill="currentColor" />,
	"needs-you": <path d="M6 1.5 11 10.5H1Z" fill="currentColor" />,
	idle: (
		<circle
			cx="6"
			cy="6"
			r="3.75"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
		/>
	),
	done: (
		<path
			d="m2 6.5 2.5 2.5L10 3.5"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	),
	failed: (
		<path
			d="m2.5 2.5 7 7m0-7-7 7"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
		/>
	),
	stopped: <rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" />,
};

export function ActivityBadge(props: { activity: Activity }): JSX.Element {
	return (
		<span class="focus-badge" data-activity={props.activity}>
			<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
				{shapes[props.activity]}
			</svg>
			{labels[props.activity]}
		</span>
	);
}
