import { docFileUrl } from "../shared/docPaths.ts";
import type { DocFile, DocStore } from "../shared/types.ts";
import { withFile, withoutFile, withoutStore, withStore } from "./docShelf.ts";
import { closeDoc, docIndex, docStores, openDoc } from "./docState.ts";

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<Outcome<T>> {
	try {
		const response = await fetch(path, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
		});
		if (response.status === 204) return { ok: true, value: undefined as T };
		const parsed = (await response.json().catch(() => null)) as
			| (T & { error?: string })
			| null;
		if (response.ok && parsed) return { ok: true, value: parsed };
		return {
			ok: false,
			error:
				parsed?.error ?? `The board server answered HTTP ${response.status}`,
		};
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

const storePath = (store: string) => `/api/docs/${encodeURIComponent(store)}`;

export async function createDocStore(
	title: string,
): Promise<Outcome<DocStore>> {
	const result = await request<DocStore>("POST", "/api/docs", {
		title: title.trim(),
	});
	if (result.ok) docStores.value = withStore(docStores.peek(), result.value);
	return result;
}

export async function renameDocStore(
	store: string,
	title: string,
): Promise<Outcome<DocStore>> {
	const result = await request<DocStore>("PATCH", storePath(store), {
		title: title.trim(),
	});
	if (result.ok) docStores.value = withStore(docStores.peek(), result.value);
	return result;
}

export async function deleteDocStore(store: string): Promise<Outcome<void>> {
	const result = await request<void>("DELETE", storePath(store));
	if (result.ok) {
		docStores.value = withoutStore(docStores.peek(), store);
		const { [store]: _gone, ...rest } = docIndex.peek();
		docIndex.value = rest;
		if (openDoc.peek()?.store === store) closeDoc();
	}
	return result;
}

export async function writeDocPage(
	store: string,
	path: string,
	content: string,
): Promise<Outcome<DocFile>> {
	const result = await request<DocFile>("PUT", docFileUrl(store, path), {
		content,
	});
	if (result.ok)
		docIndex.value = withFile(docIndex.peek(), store, result.value);
	return result;
}

export async function deleteDocPage(
	store: string,
	path: string,
): Promise<Outcome<void>> {
	const result = await request<void>("DELETE", docFileUrl(store, path));
	if (result.ok) docIndex.value = withoutFile(docIndex.peek(), store, path);
	return result;
}
