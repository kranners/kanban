import { computed, effect, signal } from "@preact/signals";
import type {
	Annotation,
	Annotations,
	Note,
	NoteColor,
	Point,
} from "../shared/types.ts";
import {
	broughtToFront,
	duplicated,
	moved,
	newNote,
	newSticker,
	recoloured,
	retexted,
	sameAnnotation,
	sentToBack,
	stacked,
	topZ,
} from "./notes.ts";
import { annotations as saved } from "./state.ts";

export type AnnotationMenu = { client: Point };
export type StickerPicker = { client: Point; board: Point };

const echoMs = 3000;
const settleMs = 400;

export const drafts = signal<ReadonlyMap<string, Annotation | null>>(new Map());
export const selection = signal<ReadonlySet<string>>(new Set());
export const editing = signal<string | null>(null);
export const annotationMenu = signal<AnnotationMenu | null>(null);
export const stickerPicker = signal<StickerPicker | null>(null);

export const current = computed<Annotations>(() => {
	const local = drafts.value;
	if (local.size === 0) return saved.value;
	const merged: Annotations = { ...saved.value };
	for (const [id, draft] of local) {
		if (draft) merged[id] = draft;
		else delete merged[id];
	}
	return merged;
});

export const ordered = computed(() => stacked(current.value));

export const selected = computed(() =>
	[...selection.value].flatMap((id) => {
		const annotation = current.value[id];
		return annotation ? [annotation] : [];
	}),
);

const newId = () => crypto.randomUUID();

function setDrafts(entries: readonly [string, Annotation | null][]): void {
	const next = new Map(drafts.peek());
	for (const [id, draft] of entries) next.set(id, draft);
	drafts.value = next;
}

function forget(id: string, draft: Annotation | null): void {
	if (drafts.peek().get(id) !== draft) return;
	const next = new Map(drafts.peek());
	next.delete(id);
	drafts.value = next;
}

function echoed(id: string, draft: Annotation | null): boolean {
	return sameAnnotation(saved.peek()[id], draft ?? undefined);
}

effect(() => {
	saved.value;
	for (const [id, draft] of drafts.peek()) {
		if (echoed(id, draft)) forget(id, draft);
	}
});

async function send(id: string, draft: Annotation | null): Promise<void> {
	const response = await fetch(`/api/annotations/${encodeURIComponent(id)}`, {
		method: draft ? "PUT" : "DELETE",
		headers: draft ? { "content-type": "application/json" } : {},
		body: draft ? JSON.stringify(draft) : undefined,
	});
	if (!response.ok && !(draft === null && response.status === 404)) {
		throw new Error(`annotation ${response.status}`);
	}
}

function persist(id: string, draft: Annotation | null): void {
	send(id, draft)
		.then(() => {
			if (echoed(id, draft)) forget(id, draft);
			else setTimeout(() => forget(id, draft), echoMs);
		})
		.catch(() => forget(id, draft));
}

export function preview(annotations: readonly Annotation[]): void {
	setDrafts(annotations.map((a) => [a.id, a]));
}

export function save(annotations: readonly Annotation[]): void {
	preview(annotations);
	for (const annotation of annotations) persist(annotation.id, annotation);
}

const settling = new Map<string, ReturnType<typeof setTimeout>>();

export function saveSoon(annotations: readonly Annotation[]): void {
	preview(annotations);
	for (const annotation of annotations) {
		clearTimeout(settling.get(annotation.id));
		settling.set(
			annotation.id,
			setTimeout(() => {
				settling.delete(annotation.id);
				const latest = drafts.peek().get(annotation.id);
				if (latest) persist(annotation.id, latest);
			}, settleMs),
		);
	}
}

export function typeText(note: Note, text: string): void {
	saveSoon([retexted(saved.peek()[note.id], note, text)]);
}

export function saveText(note: Note, text: string): void {
	save([retexted(saved.peek()[note.id], note, text)]);
}

export function select(ids: Iterable<string>): void {
	selection.value = new Set(ids);
}

export function toggleSelected(id: string): void {
	const next = new Set(selection.peek());
	if (next.has(id)) next.delete(id);
	else next.add(id);
	selection.value = next;
}

export function addNote(at: Point, color?: NoteColor): void {
	const note = newNote(newId(), at, topZ(current.peek()) + 1, color);
	save([note]);
	select([note.id]);
	editing.value = note.id;
}

export function addSticker(sticker: string, at: Point): void {
	const added = newSticker(newId(), sticker, at, topZ(current.peek()) + 1);
	save([added]);
	select([added.id]);
}

export function deleteSelection(): void {
	const ids = [...selection.peek()].filter((id) => current.peek()[id]);
	setDrafts(ids.map((id) => [id, null]));
	for (const id of ids) {
		clearTimeout(settling.get(id));
		persist(id, null);
	}
	select([]);
	editing.value = null;
}

export function duplicateSelection(): void {
	const copies = duplicated(current.peek(), selection.peek(), newId);
	save(copies);
	select(copies.map((a) => a.id));
}

export function bringSelectionToFront(): void {
	save(broughtToFront(current.peek(), selection.peek()));
}

export function sendSelectionToBack(): void {
	save(sentToBack(current.peek(), selection.peek()));
}

export function recolourSelection(color: NoteColor): void {
	save(recoloured(current.peek(), selection.peek(), color));
}

export function nudgeSelection(dx: number, dy: number): void {
	saveSoon(selected.peek().map((a) => moved(a, dx, dy)));
}

effect(() => {
	const present = current.value;
	const chosen = selection.peek();
	const kept = [...chosen].filter((id) => present[id]);
	if (kept.length !== chosen.size) selection.value = new Set(kept);
	const open = editing.peek();
	if (open && !present[open]) editing.value = null;
});
