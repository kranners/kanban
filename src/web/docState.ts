import { signal } from "@preact/signals";
import type { DocIndex } from "../shared/types.ts";

export type OpenDoc = { store: string; path: string | null; anchor?: string };
export type DocDeletion = {
	ids: string[];
	stores: { title: string; files: number }[];
};

export const docIndex = signal<DocIndex>({});
export const openDoc = signal<OpenDoc | null>(null);
export const docDeletion = signal<DocDeletion | null>(null);

export function openDocStore(
	store: string,
	path: string | null = null,
	anchor?: string,
): void {
	openDoc.value = anchor ? { store, path, anchor } : { store, path };
}

export function closeDoc(): void {
	openDoc.value = null;
}

export function fileCount(store: string): number {
	return docIndex.peek()[store]?.length ?? 0;
}
