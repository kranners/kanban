import {
	type Annotation,
	type Annotations,
	type NoteColor,
	noteColors,
} from "../shared/types.ts";
import { stickerIds } from "../web/stickers/manifest.ts";
import { parsePoint } from "./layout.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type AnnotationStore = {
	current(): Annotations;
	put(annotation: Annotation): { ok: true } | { error: string };
	remove(id: string): boolean;
	saved(): Promise<void>;
};

export type AnnotationStoreOptions = {
	file: string;
	initial: Annotations;
	onChange: (annotations: Annotations) => void;
};

export const annotationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const maxAnnotations = 500;
export const maxNoteText = 20_000;
export const minAnnotationSize = 24;
export const maxAnnotationSize = 2400;
const maxDepth = 1_000_000_000;

const isSize = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= minAnnotationSize &&
	value <= maxAnnotationSize;

const isDepth = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	Math.abs(value) <= maxDepth;

const isNoteColor = (value: unknown): value is NoteColor =>
	noteColors.includes(value as NoteColor);

const isRotation = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 180;

export const parseAnnotation = (
	id: string,
	body: unknown,
): Annotation | { error: string } => {
	if (!annotationIdPattern.test(id)) {
		return {
			error:
				"id must be 1 to 64 letters, digits, - or _, starting with a letter or digit",
		};
	}
	const point = parsePoint(body);
	if (!point) return { error: "x and y must be finite board coordinates" };
	const fields = body as Record<string, unknown>;
	const { w, h, z } = fields;
	if (!isSize(w) || !isSize(h)) {
		return {
			error: `w and h must be between ${minAnnotationSize} and ${maxAnnotationSize}`,
		};
	}
	if (!isDepth(z)) return { error: "z must be a finite number" };
	const placed = { id, ...point, w, h, z };
	if (fields.kind === "note") {
		const { text, color } = fields;
		if (typeof text !== "string" || text.length > maxNoteText) {
			return { error: `text must be a string of at most ${maxNoteText}` };
		}
		if (!isNoteColor(color)) {
			return { error: `color must be one of ${noteColors.join(", ")}` };
		}
		return { ...placed, kind: "note", text, color };
	}
	if (fields.kind === "sticker") {
		const { sticker, rotation } = fields;
		if (typeof sticker !== "string" || !stickerIds.has(sticker)) {
			return { error: "sticker must be one of the board's stickers" };
		}
		if (rotation === undefined) return { ...placed, kind: "sticker", sticker };
		if (!isRotation(rotation)) {
			return { error: "rotation must be between -180 and 180" };
		}
		return { ...placed, kind: "sticker", sticker, rotation };
	}
	return { error: "kind must be note or sticker" };
};

export const parseAnnotations = (value: unknown): Annotations => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const annotations: Annotations = {};
	for (const [id, raw] of Object.entries(value).slice(0, maxAnnotations)) {
		const parsed = parseAnnotation(id, raw);
		if (!("error" in parsed)) annotations[id] = parsed;
	}
	return annotations;
};

export const loadAnnotations = (file: string): Promise<Annotations> =>
	readState(file, parseAnnotations);

export const createAnnotationStore = ({
	file,
	initial,
	onChange,
}: AnnotationStoreOptions): AnnotationStore => {
	let annotations: Annotations = { ...initial };
	const stored = createStateFile<Annotations>(file);

	const commit = (next: Annotations) => {
		annotations = next;
		stored.write(annotations);
		onChange(annotations);
	};

	return {
		current: () => annotations,
		put(annotation) {
			const known = Object.hasOwn(annotations, annotation.id);
			if (!known && Object.keys(annotations).length >= maxAnnotations) {
				return {
					error: `The board holds at most ${maxAnnotations} notes and stickers`,
				};
			}
			commit({ ...annotations, [annotation.id]: annotation });
			return { ok: true };
		},
		remove(id) {
			if (!Object.hasOwn(annotations, id)) return false;
			const { [id]: _removed, ...rest } = annotations;
			commit(rest);
			return true;
		},
		saved: stored.saved,
	};
};
