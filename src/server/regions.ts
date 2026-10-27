import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Region, RegionDraft, RegionPatch } from "../shared/types.ts";
import { isCoordinate, writeAtomically } from "./layout.ts";
import { isDirectory } from "./sessions.ts";

export type RegionStore = {
	current(): Region[];
	create(draft: RegionDraft): Region | null;
	update(id: string, patch: RegionPatch): Region | null;
	remove(id: string): boolean;
	saved(): Promise<void>;
};

export type RegionStoreOptions = {
	file: string;
	initial: Region[];
	onChange: (regions: Region[]) => void;
	newId?: () => string;
};

export const maxRegions = 100;
export const minRegionSize = 96;
export const maxRegionSize = 20_000;
const maxNameLength = 60;
const regionIdPattern = /^[A-Za-z0-9-]{1,64}$/;
const controlCharacters = /\p{Cc}/u;

const isRegionSize = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= minRegionSize &&
	value <= maxRegionSize;

const parseName = (value: unknown): string | null | undefined | false => {
	if (value === undefined || value === null) return value;
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (trimmed.length > maxNameLength || controlCharacters.test(trimmed))
		return false;
	return trimmed || null;
};

const nameError = `name must be at most ${maxNameLength} characters on one line`;
const boundsError = `x and y must be finite, w and h between ${minRegionSize} and ${maxRegionSize}`;

const validBounds = (fields: Record<string, unknown>): boolean =>
	isCoordinate(fields.x) &&
	isCoordinate(fields.y) &&
	isRegionSize(fields.w) &&
	isRegionSize(fields.h);

export const parseRegionDraft = async (
	body: unknown,
): Promise<RegionDraft | { error: string }> => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with cwd, x, y, w and h" };
	}
	const fields = body as Record<string, unknown>;
	const { cwd, x, y, w, h } = fields;
	if (typeof cwd !== "string" || !isAbsolute(cwd)) {
		return { error: "cwd must be an absolute path" };
	}
	if (!(await isDirectory(cwd))) {
		return { error: `${cwd} is not an existing directory` };
	}
	const name = parseName(fields.name);
	if (name === false) return { error: nameError };
	if (!validBounds(fields)) return { error: boundsError };
	return {
		cwd,
		x: x as number,
		y: y as number,
		w: w as number,
		h: h as number,
		...(name ? { name } : {}),
	};
};

export const parseRegionPatch = (
	body: unknown,
): RegionPatch | { error: string } => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with name or x, y, w and h" };
	}
	const fields = body as Record<string, unknown>;
	const patch: RegionPatch = {};
	if ("name" in fields) {
		const name = parseName(fields.name);
		if (name === false || name === undefined) return { error: nameError };
		patch.name = name;
	}
	const sized = ["x", "y", "w", "h"].filter((field) => field in fields);
	if (sized.length > 0) {
		if (sized.length < 4 || !validBounds(fields)) return { error: boundsError };
		Object.assign(patch, {
			x: fields.x,
			y: fields.y,
			w: fields.w,
			h: fields.h,
		});
	}
	if (Object.keys(patch).length === 0) {
		return { error: "Nothing to change" };
	}
	return patch;
};

const parseRegion = (value: unknown): Region | null => {
	if (typeof value !== "object" || value === null) return null;
	const fields = value as Record<string, unknown>;
	const { id, cwd, x, y, w, h } = fields;
	const name = parseName(fields.name);
	if (typeof id !== "string" || !regionIdPattern.test(id)) return null;
	if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
	if (name === false || !validBounds(fields)) return null;
	return {
		id,
		cwd,
		name: name ?? null,
		x: x as number,
		y: y as number,
		w: w as number,
		h: h as number,
	};
};

export const parseRegions = (value: unknown): Region[] => {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value
		.flatMap((raw) => {
			const region = parseRegion(raw);
			if (!region || seen.has(region.id)) return [];
			seen.add(region.id);
			return [region];
		})
		.slice(0, maxRegions);
};

export const isRegionId = (value: string): boolean =>
	regionIdPattern.test(value);

export const loadRegions = async (file: string): Promise<Region[]> => {
	try {
		return parseRegions(JSON.parse(await readFile(file, "utf8")));
	} catch {
		return [];
	}
};

export const createRegionStore = ({
	file,
	initial,
	onChange,
	newId = randomUUID,
}: RegionStoreOptions): RegionStore => {
	let regions = [...initial];
	let writing: Promise<void> = Promise.resolve();
	let dirty = false;

	const persist = () => {
		if (dirty) return;
		dirty = true;
		writing = writing
			.then(() => {
				dirty = false;
				return writeAtomically(file, `${JSON.stringify(regions)}\n`);
			})
			.catch((error: unknown) => console.error("regions write failed", error));
	};

	const commit = (next: Region[]) => {
		regions = next;
		persist();
		onChange(regions);
	};

	return {
		current: () => regions,
		create(draft) {
			if (regions.length >= maxRegions) return null;
			const region: Region = { id: newId(), name: null, ...draft };
			commit([...regions, region]);
			return region;
		},
		update(id, patch) {
			const existing = regions.find((region) => region.id === id);
			if (!existing) return null;
			const updated = { ...existing, ...patch };
			commit(regions.map((region) => (region.id === id ? updated : region)));
			return updated;
		},
		remove(id) {
			if (!regions.some((region) => region.id === id)) return false;
			commit(regions.filter((region) => region.id !== id));
			return true;
		},
		saved: () => writing,
	};
};
