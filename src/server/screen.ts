import type { MirrorKey } from "../shared/types.ts";

export type ScreenRow = {
	number: number | null;
	label: string;
	checked: boolean | null;
	cursor: boolean;
};

export type ChoiceScreen = {
	kind: "choice";
	question: string;
	options: string[];
	cursor: number;
	complete: boolean;
	body: string;
};

export type AskScreen = {
	kind: "ask";
	tabs: string[];
	question: string;
	rows: ScreenRow[];
	review: boolean;
};

export type MenuScreen = { kind: "menu"; title: string };

export type ScreenDialog = ChoiceScreen | AskScreen | MenuScreen;

const pointer = "❯";
const rowPattern =
	/^\s*([❯↓↑])?\s*(?:(\d+)\.\s+)?(?:\[([ ✔✓x])\]\s+)?(.*?)\s*$/;
const numberedPattern = /^\s*(?:[❯↓↑]\s*)?\d+\.\s+\S/;
const scrollPattern = /^\s*[↓↑]/;
const tabBarPattern = /^\s*(?:←\s+)?[☐☒✔]\s+\S/;
const separatorPattern = /^\s*[─━╌]{8,}\s*$/;
const rulePattern = /^\s*[─━]{8,}\s*$/;
const panelTopPattern = /^\s*[─━▔]{8,}/;
const menuHintPattern =
	/\b(?:esc to (?:cancel|close|exit|go back)|enter to (?:continue|select|confirm))\b/i;
const modePattern = /(?:⏵⏵|⏸|⏵)\s+([a-z][a-z ]*?) on\b/i;

export const normalise = (text: string): string =>
	text.replace(/\s+/g, " ").replace(/…$/, "").trim().toLowerCase();

export const sameLabel = (shown: string, wanted: string): boolean => {
	const a = normalise(shown).replace(/ /g, "");
	const b = normalise(wanted).replace(/ /g, "");
	if (a === "" || b === "") return false;
	return (
		a === b ||
		(a.length >= 3 && b.startsWith(a)) ||
		(b.length >= 3 && a.startsWith(b))
	);
};

const lines = (screen: string): string[] =>
	screen.split("\n").map((line) => line.replace(/\s+$/, ""));

const parseRow = (line: string): ScreenRow | null => {
	const match = rowPattern.exec(line);
	if (!match) return null;
	const [, cursor, number, box, label = ""] = match;
	return {
		number: number === undefined ? null : Number(number),
		label,
		checked: box === undefined ? null : box !== " ",
		cursor: cursor === pointer,
	};
};

export function permissionMode(screen: string): string | null {
	const footer = lines(screen)
		.filter((line) => line.trim() !== "")
		.slice(-4);
	for (const line of footer.reverse()) {
		const mode = modePattern.exec(line)?.[1];
		if (mode) return mode.toLowerCase().replace(/ mode$/, "");
	}
	return null;
}

export function readDialog(screen: string): ScreenDialog | null {
	const all = lines(screen);
	const tabBar = all.findLastIndex((line) => tabBarPattern.test(line));
	if (tabBar !== -1) return readAsk(all, tabBar);
	return readChoice(all) ?? readMenu(all);
}

function footer(all: string[]): string[] {
	return all.filter((line) => line.trim() !== "").slice(-3);
}

function readMenu(all: string[]): MenuScreen | null {
	const hint = all.findLastIndex((line) => menuHintPattern.test(line));
	if (hint === -1 || !footer(all).includes(all[hint] ?? "")) return null;
	const top = all
		.slice(0, hint)
		.findLastIndex((line) => panelTopPattern.test(line));
	const title = all
		.slice(top + 1, hint)
		.find((line) => line.trim() !== "")
		?.trim();
	return { kind: "menu", title: title ?? "A menu" };
}

function readAsk(all: string[], tabBar: number): AskScreen | null {
	const tabs = [
		...(all[tabBar] ?? "").matchAll(
			/[☐☒]\s+([^☐☒✔→]+?)(?=\s{2,}|\s*[☐☒✔→]|\s*$)/g,
		),
	]
		.map((match) => match[1]?.trim() ?? "")
		.filter((tab) => tab !== "");
	const below = all.slice(tabBar + 1);
	const questionAt = below.findIndex((line) => line.trim() !== "");
	if (questionAt === -1) return null;
	const question = below[questionAt]?.trim() ?? "";
	const rows: ScreenRow[] = [];
	let afterSeparator = false;
	for (const line of below.slice(questionAt + 1)) {
		if (separatorPattern.test(line)) {
			afterSeparator = true;
			continue;
		}
		if (line.trim() === "") continue;
		const row = parseRow(line);
		if (!row) continue;
		const numbered = row.number !== null;
		const submit = row.number === null && normalise(row.label) === "submit";
		if (numbered || submit) {
			if (afterSeparator && !numbered) continue;
			rows.push(row);
		}
	}
	if (rows.length === 0) return null;
	return {
		kind: "ask",
		tabs,
		question,
		rows,
		review:
			normalise(question) === "review your answers" ||
			rows.some((row) => normalise(row.label) === "submit answers"),
	};
}

function readChoice(all: string[]): ChoiceScreen | null {
	const last = all.findLastIndex((line) => numberedPattern.test(line));
	if (last === -1) return null;
	const inputBoxBelow =
		all.slice(last + 1).filter((line) => rulePattern.test(line)).length >= 2;
	if (inputBoxBelow) return null;
	const group: ScreenRow[] = [];
	const continues = (line: string) =>
		/^\s{2,}\S/.test(line) &&
		!separatorPattern.test(line) &&
		!numberedPattern.test(line);
	let wrapped: string[] = [];
	for (let at = last + 1; continues(all[at] ?? ""); at++) {
		wrapped.push((all[at] ?? "").trim());
	}
	let clipped = false;
	let start = last;
	for (let at = last; at >= 0; at--) {
		const line = all[at] ?? "";
		if (numberedPattern.test(line)) {
			const row = parseRow(line);
			if (row) {
				group.unshift({ ...row, label: [row.label, ...wrapped].join(" ") });
			}
			if (scrollPattern.test(line)) clipped = true;
			wrapped = [];
			start = at;
		} else if (continues(line)) {
			wrapped.unshift(line.trim());
		} else {
			break;
		}
	}
	const numbers = group.map((row) => row.number ?? 0);
	const first = numbers[0] ?? 0;
	if (
		group.length < 2 ||
		first < 1 ||
		numbers.some((number, at) => number !== first + at)
	) {
		return null;
	}
	const cursor = group.find((row) => row.cursor);
	if (!cursor?.number) return null;
	const options: string[] = Array.from({ length: first - 1 }, () => "");
	for (const row of group) options.push(row.label);
	const questionAt = all
		.slice(0, start)
		.findLastIndex(
			(line) => line.trim() !== "" && !separatorPattern.test(line),
		);
	const top = all
		.slice(0, Math.max(0, questionAt))
		.findLastIndex((line) => rulePattern.test(line));
	return {
		kind: "choice",
		question: all[questionAt]?.trim() ?? "",
		options,
		cursor: cursor.number - 1,
		complete: !clipped && first === 1,
		body: all
			.slice(top === -1 ? Math.max(0, questionAt - 12) : top + 1, questionAt)
			.filter((line) => !separatorPattern.test(line))
			.join("\n")
			.trim(),
	};
}

export function moves(from: number, to: number): MirrorKey[] {
	const steps = to - from;
	return Array.from({ length: Math.abs(steps) }, () =>
		steps > 0 ? "Down" : "Up",
	);
}

export function cursorRow(rows: ScreenRow[]): number {
	return rows.findIndex((row) => row.cursor);
}
