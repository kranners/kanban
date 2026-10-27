import { signal } from "@preact/signals";
import {
	defaultRegionColour,
	type RegionColour,
	type RegionColours,
} from "../shared/colours.ts";

export const savedColours = signal<RegionColours>({});
const chosenColours = signal<ReadonlyMap<string, RegionColour | null>>(
	new Map(),
);

export function colourOf(cwd: string): RegionColour {
	const chosen = chosenColours.value.get(cwd);
	if (chosen !== undefined) return chosen ?? defaultRegionColour(cwd);
	return savedColours.value[cwd] ?? defaultRegionColour(cwd);
}

function choose(cwd: string, colour: RegionColour | null | undefined): void {
	const next = new Map(chosenColours.peek());
	if (colour === undefined) next.delete(cwd);
	else next.set(cwd, colour);
	chosenColours.value = next;
}

export function receiveColours(colours: RegionColours): void {
	savedColours.value = colours;
	const chosen = chosenColours.peek();
	for (const [cwd, colour] of chosen) {
		if ((colours[cwd] ?? null) === colour) choose(cwd, undefined);
	}
}

export async function setRegionColour(
	cwd: string,
	colour: RegionColour,
): Promise<void> {
	const stored = colour === defaultRegionColour(cwd) ? null : colour;
	choose(cwd, stored);
	try {
		const response = await fetch("/api/colours", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd, colour: stored }),
		});
		if (!response.ok) throw new Error(`colours ${response.status}`);
	} catch {
		if (chosenColours.peek().get(cwd) === stored) choose(cwd, undefined);
	}
}
