import { signal } from "@preact/signals";
import type { DocIndex, DocStore } from "../shared/types.ts";

export type OpenDoc = { store: string; path: string | null; anchor?: string };

export const docIndex = signal<DocIndex>({});
export const docStores = signal<DocStore[]>([]);
export const openDoc = signal<OpenDoc | null>(null);

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
