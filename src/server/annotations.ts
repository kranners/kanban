import {
	type Annotation,
	type Annotations,
	maxDocTitle,
	maxNoteText,
	maxReportBytes,
	type NoteColor,
	noteColors,
	type StatusReport,
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

const isDocTitle = (value: unknown): value is string =>
	typeof value === "string" &&
	value.trim() !== "" &&
	value.length <= maxDocTitle &&
	!/\p{Cc}/u.test(value);

const isLink = (value: unknown): value is string | undefined =>
	value === undefined ||
	(typeof value === "string" && annotationIdPattern.test(value));

const shotUrl = /^\/api\/report-shots\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;

const isReport = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) return false;
	const report = value as Record<string, unknown>;
	if (
		typeof report.at !== "number" ||
		typeof report.title !== "string" ||
		!Array.isArray(report.parts) ||
		!Array.isArray(report.lanes) ||
		!Array.isArray(report.shots)
	)
		return false;
	const shotsOk = report.shots.every(
		(shot) =>
			typeof shot === "object" &&
			shot !== null &&
			typeof (shot as { url?: unknown }).url === "string" &&
			shotUrl.test((shot as { url: string }).url),
	);
	return shotsOk && JSON.stringify(report).length <= maxReportBytes;
};

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
		const { text, color, session, region } = fields;
		if (typeof text !== "string" || text.length > maxNoteText) {
			return { error: `text must be a string of at most ${maxNoteText}` };
		}
		if (!isNoteColor(color)) {
			return { error: `color must be one of ${noteColors.join(", ")}` };
		}
		if (!isLink(session)) return { error: "session must be a session id" };
		if (!isLink(region)) return { error: "region must be a region id" };
		const { report } = fields;
		if (report !== undefined && !isReport(report)) {
			return {
				error: `report must be a status report of at most ${maxReportBytes} bytes`,
			};
		}
		return {
			...placed,
			kind: "note",
			text,
			color,
			...(session === undefined ? {} : { session }),
			...(region === undefined ? {} : { region }),
			...(report === undefined ? {} : { report: report as StatusReport }),
		};
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
	if (fields.kind === "docs") {
		const { title } = fields;
		if (!isDocTitle(title)) {
			return {
				error: `title must be 1 to ${maxDocTitle} characters on one line`,
			};
		}
		return { ...placed, kind: "docs", title };
	}
	return { error: "kind must be note, sticker or docs" };
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
			const kind = annotations[annotation.id]?.kind;
			if (known && kind !== annotation.kind) {
				return {
					error: `${annotation.id} is a ${kind}: delete it to make a ${annotation.kind}`,
				};
			}
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
