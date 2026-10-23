import { computed, signal } from "@preact/signals";
import type { Session } from "../shared/types.ts";
import type { PlacedNode } from "./layout.ts";

export type ExitState =
	| {
			phase: "checking";
			force: boolean;
			session: Session;
			node: PlacedNode | undefined;
	  }
	| { phase: "refused"; title: string; message: string }
	| { phase: "leaving"; session: Session; node: PlacedNode | undefined }
	| { phase: "gone" };

export const exits = signal<ReadonlyMap<string, ExitState>>(new Map());

function idsIn(phases: ReadonlySet<ExitState["phase"]>): Set<string> {
	return new Set(
		[...exits.value]
			.filter(([, state]) => phases.has(state.phase))
			.map(([id]) => id),
	);
}

export const departed = computed(() => idsIn(new Set(["gone"])));

export const departing = computed(() => idsIn(new Set(["leaving", "gone"])));
