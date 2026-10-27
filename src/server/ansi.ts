const escapeChar = String.fromCharCode(27);
const bellChar = String.fromCharCode(7);
const ansiSequence = new RegExp(
	[
		`${escapeChar}\\[[0-?]*[ -/]*[@-~]`,
		`${escapeChar}\\][^${bellChar}${escapeChar}]*(?:${bellChar}|${escapeChar}\\\\)?`,
		`${escapeChar}[PX^_][^${escapeChar}]*(?:${escapeChar}\\\\)?`,
		`${escapeChar}[ -~]`,
	].join("|"),
	"g",
);

export const stripAnsi = (text: string): string =>
	text.replace(ansiSequence, "");

export const lastLine = (text: string): string =>
	stripAnsi(text).trim().split("\n").at(-1)?.trim() ?? "";
