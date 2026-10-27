import type {
	Annotation,
	Annotations,
	Note,
	NoteColor,
	Point,
	Sticker,
} from "../shared/types.ts";
import type { KeyPress } from "./actions.ts";
import { gridSize } from "./grid.ts";
import type { StickerEntry } from "./stickers/manifest.ts";

export const noteSize = 192;
export const stickerSize = 96;
export const minNoteSize = 96;
export const minStickerSize = 32;
export const maxAnnotationSize = 1200;
export const noteTextLimit = 2000;
export const defaultNoteColor: NoteColor = "yellow";

const notePadding = 14;
const lineHeight = 1.3;
const glyphWidth = 0.55;
const largestFont = 40;
const smallestFont = 11;

export function stacked(annotations: Annotations): Annotation[] {
	return Object.values(annotations).sort(
		(a, b) => a.z - b.z || a.id.localeCompare(b.id),
	);
}

export function sameAnnotation(
	a: Annotation | undefined,
	b: Annotation | undefined,
): boolean {
	if (!a || !b) return a === b;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every(
		(key) => a[key as keyof Annotation] === b[key as keyof Annotation],
	);
}

export function topZ(annotations: Annotations): number {
	return Math.max(0, ...Object.values(annotations).map((a) => a.z));
}

export function centredAt(point: Point, size: number): Point {
	return {
		x: Math.round(point.x - size / 2),
		y: Math.round(point.y - size / 2),
	};
}

export function newNote(
	id: string,
	at: Point,
	z: number,
	color: NoteColor = defaultNoteColor,
): Note {
	return {
		id,
		kind: "note",
		...centredAt(at, noteSize),
		w: noteSize,
		h: noteSize,
		z,
		text: "",
		color,
	};
}

export function newSticker(
	id: string,
	sticker: string,
	at: Point,
	z: number,
): Sticker {
	return {
		id,
		kind: "sticker",
		...centredAt(at, stickerSize),
		w: stickerSize,
		h: stickerSize,
		z,
		sticker,
	};
}

function linesFor(text: string, charsPerLine: number): number {
	return text
		.split("\n")
		.reduce(
			(lines, paragraph) =>
				lines + Math.max(1, Math.ceil(paragraph.length / charsPerLine)),
			0,
		);
}

export function noteFontSize(text: string, w: number, h: number): number {
	const width = Math.max(1, w - notePadding * 2);
	const height = Math.max(1, h - notePadding * 2);
	for (let size = largestFont; size > smallestFont; size -= 1) {
		const charsPerLine = Math.max(1, Math.floor(width / (size * glyphWidth)));
		if (linesFor(text, charsPerLine) * size * lineHeight <= height) return size;
	}
	return smallestFont;
}

const clampSize = (value: number, min: number) =>
	Math.round(Math.min(maxAnnotationSize, Math.max(min, value)));

export function moved<T extends Annotation>(
	annotation: T,
	dx: number,
	dy: number,
): T {
	return {
		...annotation,
		x: Math.round(annotation.x + dx),
		y: Math.round(annotation.y + dy),
	};
}

export function resized<T extends Annotation>(
	annotation: T,
	dx: number,
	dy: number,
): T {
	if (annotation.kind === "note") {
		return {
			...annotation,
			w: clampSize(annotation.w + dx, minNoteSize),
			h: clampSize(annotation.h + dy, minNoteSize),
		};
	}
	const scale = Math.max(
		(annotation.w + dx) / annotation.w,
		(annotation.h + dy) / annotation.h,
	);
	const w = clampSize(annotation.w * scale, minStickerSize);
	const h = clampSize((w * annotation.h) / annotation.w, minStickerSize);
	return { ...annotation, w, h };
}

function selected(annotations: Annotations, ids: Iterable<string>) {
	return stacked(
		Object.fromEntries(
			[...ids].flatMap((id) => {
				const annotation = annotations[id];
				return annotation ? [[id, annotation]] : [];
			}),
		),
	);
}

export function broughtToFront(
	annotations: Annotations,
	ids: Iterable<string>,
): Annotation[] {
	const others = Object.values(annotations).filter(
		(a) => !new Set(ids).has(a.id),
	);
	const top = Math.max(0, ...others.map((a) => a.z));
	return selected(annotations, ids).map((a, index) => ({
		...a,
		z: top + index + 1,
	}));
}

export function sentToBack(
	annotations: Annotations,
	ids: Iterable<string>,
): Annotation[] {
	const chosen = selected(annotations, ids);
	const others = Object.values(annotations).filter((a) => !chosen.includes(a));
	const bottom = Math.min(0, ...others.map((a) => a.z));
	return chosen.map((a, index) => ({
		...a,
		z: bottom - chosen.length + index,
	}));
}

export function duplicated(
	annotations: Annotations,
	ids: Iterable<string>,
	newId: () => string,
): Annotation[] {
	const top = topZ(annotations);
	return selected(annotations, ids).map((a, index) => ({
		...moved(a, gridSize, gridSize),
		id: newId(),
		z: top + index + 1,
	}));
}

export function recoloured(
	annotations: Annotations,
	ids: Iterable<string>,
	color: NoteColor,
): Note[] {
	return selected(annotations, ids).flatMap((a) =>
		a.kind === "note" && a.color !== color ? [{ ...a, color }] : [],
	);
}

export function matchingStickers(
	stickers: readonly StickerEntry[],
	query: string,
): StickerEntry[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...stickers];
	return stickers.filter((sticker) => {
		const haystack = [sticker.id, sticker.name, ...sticker.keywords]
			.join(" ")
			.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

export function gridStep(
	index: number,
	key: string,
	columns: number,
	count: number,
): number {
	if (count === 0) return 0;
	const steps: Record<string, number> = {
		ArrowLeft: -1,
		ArrowRight: 1,
		ArrowUp: -columns,
		ArrowDown: columns,
	};
	const step = steps[key];
	if (step === undefined) return index;
	const next = index + step;
	return next < 0 || next >= count ? index : next;
}

export type AnnotationCommand =
	| { kind: "note" }
	| { kind: "sticker" }
	| { kind: "delete" }
	| { kind: "duplicate" }
	| { kind: "front" }
	| { kind: "back" }
	| { kind: "edit" }
	| { kind: "deselect" }
	| { kind: "nudge"; dx: number; dy: number };

const nudges: Record<string, Point> = {
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 },
	ArrowUp: { x: 0, y: -1 },
	ArrowDown: { x: 0, y: 1 },
};

export function annotationCommand(
	press: KeyPress,
	selection: { count: number; notes: number },
): AnnotationCommand | null {
	const command = press.metaKey || press.ctrlKey;
	const key = press.key.toLowerCase();
	if (press.altKey) return null;
	if (command) {
		if (selection.count === 0 || press.shiftKey) return null;
		if (key === "d") return { kind: "duplicate" };
		if (key === "]") return { kind: "front" };
		if (key === "[") return { kind: "back" };
		return null;
	}
	const nudge = nudges[press.key];
	if (nudge && selection.count > 0) {
		const step = press.shiftKey ? gridSize : 1;
		return { kind: "nudge", dx: nudge.x * step, dy: nudge.y * step };
	}
	if (press.shiftKey || press.repeat) return null;
	if (key === "n") return { kind: "note" };
	if (key === "s") return { kind: "sticker" };
	if (selection.count === 0) return null;
	if (key === "delete" || key === "backspace") return { kind: "delete" };
	if (key === "escape") return { kind: "deselect" };
	if (key === "enter" && selection.count === 1 && selection.notes === 1) {
		return { kind: "edit" };
	}
	return null;
}
