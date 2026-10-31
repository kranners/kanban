import type {
	Annotations,
	DocFile,
	DocIndex,
	DocStore,
} from "../shared/types.ts";
import { docStoreChoices } from "./docsPicker.ts";

export type ShelfEntry = { store: DocStore; files: DocFile[] };

const folded = (text: string): string => text.toLocaleLowerCase();

export function docShelf(
	annotations: Annotations,
	index: DocIndex,
	query: string,
): ShelfEntry[] {
	const needle = folded(query.trim());
	return docStoreChoices(annotations).flatMap((store) => {
		const files = index[store.id] ?? [];
		if (!needle) return [{ store, files }];
		if (folded(store.title).includes(needle)) return [{ store, files }];
		const matched = files.filter((file) => folded(file.path).includes(needle));
		return matched.length > 0 ? [{ store, files: matched }] : [];
	});
}

export function shelfFileCount(entries: readonly ShelfEntry[]): number {
	return entries.reduce((total, entry) => total + entry.files.length, 0);
}
