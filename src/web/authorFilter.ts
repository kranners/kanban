import { signal } from "@preact/signals";
import {
	type AuthorFilter,
	type CardAuthorKind,
	cardAuthorKinds,
} from "./cardFace.ts";

export const authorFilterKey = "kanban.authorFilter";

function readFilter(): AuthorFilter {
	try {
		const kept = localStorage.getItem(authorFilterKey);
		return (cardAuthorKinds as readonly string[]).includes(kept ?? "")
			? (kept as CardAuthorKind)
			: "all";
	} catch {
		return "all";
	}
}

export const authorFilter = signal<AuthorFilter>(readFilter());

export function setAuthorFilter(filter: AuthorFilter): void {
	authorFilter.value = filter;
	try {
		localStorage.setItem(authorFilterKey, filter);
	} catch {}
}
