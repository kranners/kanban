import { computed, signal } from "@preact/signals";
import { projectsOfCards } from "../shared/butlerRegions.ts";
import type { ButlerCard, Region } from "../shared/types.ts";
import { projectsById, projectsListing } from "./projects.ts";
import {
	filterKey,
	type ProjectTile,
	tileKeyOf,
	tileOf,
} from "./projectTiles.ts";
import { annotations } from "./state.ts";

export * from "./projectTiles.ts";

const butlerCards = computed(() =>
	Object.values(annotations.value).filter(
		(a): a is ButlerCard => a.kind === "butler-card",
	),
);

/** Each of Butler's cards' project, as Tidy reads it. */
export const cardOwners = computed(() =>
	projectsOfCards(butlerCards.value, projectsListing.value.projects),
);

export function tileFor(region: Region, now: number): ProjectTile | null {
	const key = tileKeyOf(region.cwd);
	if (key === undefined) return null;
	return tileOf(
		key,
		butlerCards.value,
		cardOwners.value,
		projectsById.value,
		now,
	);
}

/** The one project the board shows, by id or `unsorted`, the rest dimmed; null shows them all. */
export const projectFilter = signal<string | null>(null);

export function toggleProjectFilter(key: string | null): void {
	projectFilter.value =
		projectFilter.peek() === filterKey(key) ? null : filterKey(key);
}

export const isFilteredTo = (key: string | null): boolean =>
	projectFilter.value === filterKey(key);
