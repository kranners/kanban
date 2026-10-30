import type { JSX } from "preact";
import { type RunsOn, runsOnChoices } from "../shared/types.ts";

const runsOnLabels: Record<RunsOn, string> = {
	cloud: "Cloud",
	local: "This Mac",
};

export function RunsOnPicker(props: {
	runsOn: RunsOn;
	onPick: (runsOn: RunsOn) => void;
	disabled?: boolean;
	class?: string;
	labelledBy?: string;
}): JSX.Element {
	return (
		<select
			aria-labelledby={props.labelledBy}
			aria-label={props.labelledBy ? undefined : "Where it runs"}
			class={props.class}
			value={props.runsOn}
			disabled={props.disabled}
			title="Where this session runs"
			onChange={(event) => props.onPick(event.currentTarget.value as RunsOn)}
		>
			{runsOnChoices.map((choice) => (
				<option key={choice} value={choice}>
					{runsOnLabels[choice]}
				</option>
			))}
		</select>
	);
}
