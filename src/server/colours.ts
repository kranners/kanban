import {
	isRegionColour,
	type RegionColours,
	type RegionColourUpdate,
} from "../shared/colours.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type ColourStore = {
	current(): RegionColours;
	set(update: RegionColourUpdate): boolean;
	saved(): Promise<void>;
};

export type ColourStoreOptions = {
	file: string;
	initial: RegionColours;
	onChange: (colours: RegionColours) => void;
};

export const maxColours = 200;
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
		Object.entries(value)
			.filter(([cwd, colour]) => isCwd(cwd) && isRegionColour(colour))
			.slice(0, maxColours),
	);
};

export const loadColours = (file: string): Promise<RegionColours> =>
	readState(file, parseColours);

export const createColourStore = ({
	file,
	initial,
	onChange,
}: ColourStoreOptions): ColourStore => {
	let colours: RegionColours = { ...initial };
	const stored = createStateFile<RegionColours>(file);

	return {
		current: () => colours,
		set({ cwd, colour }) {
			const full = Object.keys(colours).length >= maxColours;
			if (colour !== null && full && !(cwd in colours)) return false;
			const { [cwd]: _, ...rest } = colours;
			colours = colour === null ? rest : { ...rest, [cwd]: colour };
			stored.write(colours);
			onChange(colours);
			return true;
		},
		saved: stored.saved,
	};
};
