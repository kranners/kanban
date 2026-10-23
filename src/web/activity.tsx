import {
	Circle,
	CircleCheck,
	CircleX,
	Square,
	TriangleAlert,
} from "lucide-preact";
import type { Activity } from "../shared/types.ts";

export const activityOrder: Activity[] = [
	"needs-you",
	"working",
	"idle",
	"done",
	"failed",
	"stopped",
];

export const activityLabel: Record<Activity, string> = {
	working: "Working",
	"needs-you": "Needs you",
	idle: "Idle",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
};

export function ActivityIcon(props: { activity: Activity; size?: number }) {
	const size = props.size ?? 12;
	const common = { size, strokeWidth: 2.25, "aria-hidden": true };
	switch (props.activity) {
		case "working":
			return (
				<span
					class="pulse"
					style={{ width: `${size}px`, height: `${size}px` }}
					aria-hidden="true"
				/>
			);
		case "needs-you":
			return <TriangleAlert {...common} />;
		case "idle":
			return <Circle {...common} />;
		case "done":
			return <CircleCheck {...common} />;
		case "failed":
			return <CircleX {...common} />;
		case "stopped":
			return <Square {...common} />;
	}
}

export function ActivityBadge(props: { activity: Activity }) {
	return (
		<span class={`badge act-${props.activity}`}>
			<ActivityIcon activity={props.activity} />
			{activityLabel[props.activity]}
		</span>
	);
}
