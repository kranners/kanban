import { isDocPath, isTextPath } from "../shared/docPaths.ts";
import {
	type DocFile,
	type DocIndex,
	type DocStore,
	maxDocTitle,
} from "../shared/types.ts";

export type ShelfEntry = { store: DocStore; files: DocFile[] };

const folded = (text: string): string => text.toLocaleLowerCase();

const byTitle = (a: DocStore, b: DocStore): number =>
	folded(a.title).localeCompare(folded(b.title)) || a.id.localeCompare(b.id);

export function docShelf(
	stores: readonly DocStore[],
	index: DocIndex,
	query: string,
): ShelfEntry[] {
	const needle = folded(query.trim());
	return [...stores].sort(byTitle).flatMap((store) => {
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

export function titleProblem(input: string): string | null {
	const title = input.trim();
	if (!title) return "Give the doc store a title";
	if (title.length > maxDocTitle)
		return `Keep the title to ${maxDocTitle} characters`;
	if (/\p{Cc}/u.test(title)) return "Keep the title to one line";
	return null;
}

export function pagePathProblem(
	input: string,
	files: readonly DocFile[],
): string | null {
	const path = input.trim();
	if (!path) return "Name the page, like notes/setup.md";
	if (!isDocPath(path))
		return "Use letters, digits, dots, dashes and underscores, with folders separated by /, ending in .md, .txt, .json, .csv or .svg";
	if (!isTextPath(path))
		return "Pages are text: .md, .txt, .json, .csv or .svg";
	if (files.some((file) => file.path === path))
		return `${path} already exists: open it and edit it instead`;
	return null;
}

export function withStore(
	stores: readonly DocStore[],
	store: DocStore,
): DocStore[] {
	return [...stores.filter((s) => s.id !== store.id), store].sort(byTitle);
}

export function withoutStore(
	stores: readonly DocStore[],
	id: string,
): DocStore[] {
	return stores.filter((store) => store.id !== id);
}

export function withFile(
	index: DocIndex,
	store: string,
	file: DocFile,
): DocIndex {
	const files = (index[store] ?? []).filter((f) => f.path !== file.path);
	return { ...index, [store]: [...files, file] };
}

export function withoutFile(
	index: DocIndex,
	store: string,
	path: string,
): DocIndex {
	const files = index[store];
	if (!files) return index;
	return { ...index, [store]: files.filter((file) => file.path !== path) };
}
