const units: [number, string][] = [
	[86_400_000, "d"],
	[3_600_000, "h"],
	[60_000, "m"],
	[1000, "s"],
];

export function relativeTime(at: number, now: number): string {
	const elapsed = Math.max(0, now - at);
	if (elapsed < 5000) return "now";
	for (const [size, unit] of units) {
		if (elapsed >= size) return `${Math.floor(elapsed / size)}${unit}`;
	}
	return "now";
}
