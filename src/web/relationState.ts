import { computed, effect, signal } from "@preact/signals";
import type { Relation, RelationDraft } from "../shared/types.ts";

export const relations = signal<Relation[]>([]);

const unlinking = signal<ReadonlySet<string>>(new Set());

export const shownRelations = computed(() => {
	const hidden = unlinking.value;
	return hidden.size === 0
		? relations.value
		: relations.value.filter((relation) => !hidden.has(relation.id));
});

function setUnlinking(id: string, on: boolean): void {
	const next = new Set(unlinking.peek());
	if (on) next.add(id);
	else next.delete(id);
	unlinking.value = next;
}

async function errorOf(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as {
		error?: string;
	} | null;
	return body?.error ?? `The board server answered HTTP ${response.status}`;
}

export async function createRelation(
	draft: RelationDraft,
): Promise<string | null> {
	try {
		const response = await fetch("/api/relations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(draft),
		});
		return response.ok ? null : await errorOf(response);
	} catch (caught) {
		return `Couldn't reach the board server (${caught})`;
	}
}

export async function removeRelation(id: string): Promise<void> {
	setUnlinking(id, true);
	try {
		const response = await fetch(`/api/relations/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		if (!response.ok) setUnlinking(id, false);
	} catch {
		setUnlinking(id, false);
	}
}

effect(() => {
	const present = new Set(relations.value.map((relation) => relation.id));
	const hidden = unlinking.peek();
	const echoed = [...hidden].filter((id) => !present.has(id));
	if (echoed.length > 0) {
		unlinking.value = new Set([...hidden].filter((id) => present.has(id)));
	}
});
