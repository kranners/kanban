import { readFile } from "node:fs/promises";
import {
	isRegionColour,
	type RegionColours,
	type RegionColourUpdate,
} from "../shared/colours.ts";
import { writeAtomically } from "./layout.ts";

export type ColourStore = {
	current(): RegionColours;
	set(update: RegionColourUpdate): void;
	saved(): Promise<void>;
};

export type ColourStoreOptions = {
	file: string;
	initial: RegionColours;
	onChange: (colours: RegionColours) => void;
};

const maxCwdLength = 4096;

const isCwd = (value: unknown): value is string =>
	typeof value === "string" &&
	value.startsWith("/") &&
	value.length <= maxCwdLength &&
	!value.includes("\0");

export const parseColourUpdate = (
	body: unknown,
): RegionColourUpdate | { error: string } => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with cwd and colour" };
	}
	const { cwd, colour } = body as Record<string, unknown>;
	if (!isCwd(cwd)) return { error: "cwd must be an absolute path" };
	if (colour !== null && !isRegionColour(colour)) {
		return { error: "colour must be a palette colour or null" };
	}
	return { cwd, colour };
};

export const parseColours = (value: unknown): RegionColours => {
	if (typeof value !== "object" || value === null) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			([cwd, colour]) => isCwd(cwd) && isRegionColour(colour),
		),
	);
};

export const loadColours = async (file: string): Promise<RegionColours> => {
	try {
		return parseColours(JSON.parse(await readFile(file, "utf8")));
	} catch {
		return {};
	}
};

export const createColourStore = ({
	file,
	initial,
	onChange,
}: ColourStoreOptions): ColourStore => {
	let colours: RegionColours = { ...initial };
	let writing: Promise<void> = Promise.resolve();
	let dirty = false;

	const persist = () => {
		if (dirty) return;
		dirty = true;
		writing = writing
			.then(() => {
				dirty = false;
				return writeAtomically(file, `${JSON.stringify(colours)}\n`);
			})
			.catch((error: unknown) => console.error("colours write failed", error));
	};

	return {
		current: () => colours,
		set({ cwd, colour }) {
			const { [cwd]: _, ...rest } = colours;
			colours = colour === null ? rest : { ...rest, [cwd]: colour };
			persist();
			onChange(colours);
		},
		saved: () => writing,
	};
};
