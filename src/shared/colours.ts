export const regionColours = [
	"stone",
	"red",
	"amber",
	"green",
	"teal",
	"blue",
	"violet",
	"pink",
] as const;

export type RegionColour = (typeof regionColours)[number];

export type RegionColours = Record<string, RegionColour>;

export type RegionColourUpdate = { cwd: string; colour: RegionColour | null };

export const isRegionColour = (value: unknown): value is RegionColour =>
	regionColours.includes(value as RegionColour);

export const defaultRegionColour = (cwd: string): RegionColour => {
	let hash = 0x811c9dc5;
	for (const char of cwd) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}
	return regionColours[(hash >>> 0) % regionColours.length] ?? "stone";
};
