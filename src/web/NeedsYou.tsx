import { ArrowRight, TriangleAlert } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { countNeedingYou, isNextNeedingYouKey } from "./attention.ts";
import { needing, visitNextNeedingYou } from "./attentionState.ts";
import type { NodeKey } from "./layout.ts";
import { blocked, isTyping } from "./Spawning.tsx";

export function useNeedsYouShortcut(): void {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.isComposing || blocked()) return;
			if (!isNextNeedingYouKey(event, isTyping(event.target))) return;
			event.preventDefault();
			visitNextNeedingYou();
		};
		addEventListener("keydown", onKeyDown);
		return () => removeEventListener("keydown", onKeyDown);
	}, []);
}

export function NextNeedingYou(): JSX.Element | null {
	const count = needing.value.size;
	if (count === 0) return null;
	return (
		<button
			type="button"
			class="next-needing-you"
			onClick={visitNextNeedingYou}
			title="Go to the next session that needs you (J)"
		>
			<TriangleAlert size={13} strokeWidth={2.25} aria-hidden="true" />
			<span class="num">{count}</span>
			<span class="next-needing-you-label">
				{count === 1 ? "needs you" : "need you"}
			</span>
			<ArrowRight size={13} aria-hidden="true" />
			<kbd>J</kbd>
		</button>
	);
}

export function NeedsYouCount(props: {
	members: readonly NodeKey[];
}): JSX.Element | null {
	const count = countNeedingYou(props.members, needing.value);
	if (count === 0) return null;
	return (
		<span
			class="group-needs num"
			title={`${count} ${count === 1 ? "session needs" : "sessions need"} you`}
		>
			<TriangleAlert size={10} strokeWidth={2.5} aria-hidden="true" />
			{count}
		</span>
	);
}

export function needsYouClass(members: readonly NodeKey[]): string {
	return countNeedingYou(members, needing.value) > 0 ? " wants-you" : "";
}
