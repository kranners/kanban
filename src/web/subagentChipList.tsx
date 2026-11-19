import type { JSX } from "preact";
import { subagentState } from "../shared/subagents.ts";
import type { Subagent } from "../shared/types.ts";
import { chipName } from "./subagentChips.ts";
import { relativeTime } from "./time.ts";

/** A card's newest subagents as chips, and how many more it has; each opens when given a way to. */
export function SubagentChipList(props: {
	shown: readonly Subagent[];
	more: number;
	now: number;
	onOpen?: (subagent: Subagent, origin: DOMRect) => void;
}): JSX.Element | null {
	const { shown, more } = props;
	if (shown.length === 0) return null;
	return (
		<div class="sub-chips">
			{shown.map((subagent) => {
				const state = subagentState(subagent);
				const name = chipName(subagent);
				return (
					<button
						key={subagent.id}
						type="button"
						class={`sub-chip act-${state}`}
						data-no-pan
						title={`${subagent.description || subagent.type} · ${subagent.type}`}
						aria-label={`Open subagent ${name}, ${state}`}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							props.onOpen?.(
								subagent,
								event.currentTarget.getBoundingClientRect(),
							);
						}}
					>
						<span class="sub-chip-dot" aria-hidden="true" />
						<span class="sub-chip-name">{name}</span>
						<time class="sub-chip-time num">
							{relativeTime(subagent.updatedAt, props.now)}
						</time>
					</button>
				);
			})}
			{more > 0 && (
				<span
					class="sub-chip-more num"
					title={`${more} more ${more === 1 ? "subagent" : "subagents"}`}
				>
					+{more}
				</span>
			)}
		</div>
	);
}
