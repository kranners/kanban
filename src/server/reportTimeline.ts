import type { Session, TokenUsage } from "../shared/types.ts";
import { averageTaskMs } from "../web/timeline.ts";

export type SectionKey = "done" | "goal" | "left" | "needs";

export type PlanStep = { ms: number; text: string };

export type ParsedReport = {
	sections: Partial<Record<SectionKey, string>>;
	plan: PlanStep[];
};

export type Entry = { at: number; text: string; predicted: boolean };

const sectionTitles: Record<SectionKey, string> = {
	done: "Done so far",
	goal: "Goal",
	left: "Left",
	needs: "Needs you",
};

const sectionOrder: readonly SectionKey[] = ["done", "goal", "left", "needs"];

const headingKeys: Record<string, SectionKey | "plan"> = {
	"done so far": "done",
	goal: "goal",
	left: "left",
	"needs you": "needs",
	plan: "plan",
};

const headingPattern =
	/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(done so far|goal|left|needs you|plan)\s*(?::\s*(?:\*\*|__)|(?:\*\*|__)\s*:|:|(?:\*\*|__))?\s*(.*)$/i;

const minute = 60_000;
const hour = 60 * minute;

const unitMs = (unit: string): number =>
	unit.toLowerCase().startsWith("h") ? hour : minute;

const durationPattern =
	/^((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b\s*)+)\s*[:\-–—]\s*(.+)$/i;

const durationPart = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi;

export const parsePlanLine = (line: string): PlanStep | null => {
	const bare = line
		.trim()
		.replace(/^(?:[-*•+]|\d+[.)])\s*/, "")
		.replace(/\*\*|__|`/g, "")
		.trim();
	const match = durationPattern.exec(bare);
	if (!match) return null;
	let ms = 0;
	for (const [, amount, unit] of (match[1] ?? "").matchAll(durationPart))
		ms += Number(amount) * unitMs(unit ?? "m");
	const text = (match[2] ?? "").trim();
	return text ? { ms: Math.round(ms), text } : null;
};

const paragraph = (lines: string[]): string =>
	lines
		.map((line) => line.trim().replace(/^(?:[-*•+]|\d+[.)])\s+/, ""))
		.filter((line) => line !== "")
		.join(" ");

const isNone = (text: string): boolean =>
	/^(?:_?\(?(?:none|nothing|n\/a|-)\)?\.?_?)$/i.test(text.trim());

export const parseReport = (answer: string): ParsedReport | null => {
	const collected = new Map<SectionKey | "plan", string[]>();
	let current: SectionKey | "plan" | null = null;
	for (const line of answer.split(/\r?\n/)) {
		const heading = headingPattern.exec(line);
		const key = heading ? headingKeys[(heading[1] ?? "").toLowerCase()] : null;
		const rest = heading?.[2]?.trim() ?? "";
		const marked =
			rest === "" || /[:*_#]/.test(line.slice(0, line.length - rest.length));
		if (key && marked) {
			current = key;
			collected.set(key, rest ? [rest] : []);
			continue;
		}
		if (current) collected.get(current)?.push(line);
	}
	const sections: Partial<Record<SectionKey, string>> = {};
	for (const key of sectionOrder) {
		const text = paragraph(collected.get(key) ?? []);
		if (text && !isNone(text)) sections[key] = text;
	}
	const plan = (collected.get("plan") ?? []).flatMap((line) => {
		const step = parsePlanLine(line);
		return step ? [step] : [];
	});
	if (Object.keys(sections).length === 0 && plan.length === 0) return null;
	return { sections, plan };
};

export const sectionsText = (parsed: ParsedReport): string =>
	sectionOrder
		.flatMap((key) => {
			const text = parsed.sections[key];
			return text ? [`**${sectionTitles[key]}:** ${text}`] : [];
		})
		.join("\n\n");

export const clock = (at: number | Date): string =>
	new Date(at).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
	});

export const formatDuration = (ms: number): string => {
	const minutes = Math.max(0, Math.floor(ms / minute));
	const days = Math.floor(minutes / (24 * 60));
	const hours = Math.floor(minutes / 60) % 24;
	const mins = minutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
};

export const compactCount = (n: number): string => {
	const short = (value: number, unit: string) =>
		`${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
	if (n >= 999_950) return short(n / 1_000_000, "M");
	if (n >= 1000) return short(n / 1000, "k");
	return String(Math.round(n));
};

export const totalTokens = (tokens: TokenUsage): number =>
	tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

export const tokensText = (sessions: readonly Session[]): string => {
	const known = sessions.flatMap((s) => (s.tokens ? [s.tokens] : []));
	if (known.length === 0) return "Tokens unknown";
	const total = known.reduce((sum, t) => sum + totalTokens(t), 0);
	const output = known.reduce((sum, t) => sum + t.output, 0);
	const partial =
		known.length < sessions.length ? " (some sessions unknown)" : "";
	return `${compactCount(total)} tokens, ${compactCount(output)} output${partial}`;
};

export const statsText = (sessions: readonly Session[], now: Date): string => {
	const start = Math.min(...sessions.map((s) => s.startedAt));
	return [
		"**Stats**",
		"",
		`- Running ${formatDuration(now.getTime() - start)}`,
		`- ${tokensText(sessions)}`,
	].join("\n");
};

const maxPast = 8;
const recentSteps = 3;

export const pastEntries = (session: Session, now: number): Entry[] => {
	const entries: Entry[] = [];
	for (const task of session.tasks) {
		if (task.status === "completed" && task.endedAt !== null)
			entries.push({
				at: task.endedAt,
				text: `Done: ${task.subject}`,
				predicted: false,
			});
		else if (task.status === "in_progress" && task.startedAt !== null)
			entries.push({
				at: task.startedAt,
				text: `Started: ${task.activeForm ?? task.subject}`,
				predicted: false,
			});
	}
	for (const step of session.steps.slice(-recentSteps))
		entries.push({ at: step.at, text: step.text, predicted: false });
	const recent = entries
		.filter((e) => e.at <= now && e.at >= session.startedAt)
		.sort((a, b) => a.at - b.at)
		.slice(-(maxPast - 1));
	return [
		{ at: session.startedAt, text: "Session started", predicted: false },
		...recent,
	];
};

export const futureEntries = (
	session: Session,
	plan: readonly PlanStep[],
	now: number,
	fallbackMs: number | null = null,
): { entries: Entry[]; finish: number | null } => {
	if (plan.length > 0) {
		let cursor = now;
		const entries = plan.map((step) => {
			cursor += step.ms;
			return { at: cursor, text: step.text, predicted: true };
		});
		return { entries, finish: cursor };
	}
	const open = session.tasks.filter((t) => t.status !== "completed");
	if (open.length === 0) return { entries: [], finish: null };
	const typical = averageTaskMs([session]) ?? fallbackMs;
	if (typical === null) return { entries: [], finish: null };
	let cursor = now;
	const entries: Entry[] = [];
	for (const task of open.filter((t) => t.status === "in_progress")) {
		const end = Math.max(now, (task.startedAt ?? now) + typical);
		cursor = Math.max(cursor, end);
		entries.push({ at: end, text: task.subject, predicted: true });
	}
	for (const task of open.filter((t) => t.status === "pending")) {
		cursor += typical;
		entries.push({ at: cursor, text: task.subject, predicted: true });
	}
	entries.sort((a, b) => a.at - b.at);
	return { entries, finish: cursor };
};

const maxEntryText = 120;

export const entryText = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	const short =
		flat.length > maxEntryText ? `${flat.slice(0, maxEntryText - 1)}…` : flat;
	return short.replace(/[~\\]/g, (c) => `\\${c}`);
};

const entryLine = (entry: Entry): string =>
	`- ${entry.predicted ? "~" : ""}${clock(entry.at)} ${entryText(entry.text)}`;

export const timelineText = (
	past: readonly Entry[],
	now: number,
	future: readonly Entry[],
	finish: number | null,
): string =>
	[
		"**Timeline**",
		"",
		...past.map(entryLine),
		`- **${clock(now)} Now**`,
		...future.map(entryLine),
		finish === null
			? "- Completion time unknown"
			: `- **~${clock(finish)} Predicted completion**`,
	].join("\n");

export const sessionReportBody = (
	session: Session,
	answer: string,
	now: Date,
): string => {
	const parsed = parseReport(answer);
	const at = now.getTime();
	const { entries, finish } = futureEntries(session, parsed?.plan ?? [], at);
	return [
		(parsed && sectionsText(parsed)) || answer.trim(),
		statsText([session], now),
		timelineText(pastEntries(session, at), at, entries, finish),
	].join("\n\n");
};

export type RegionAnswer = {
	session: Session;
	answer: { ok: true; answer: string } | { ok: false; error: string };
};

const prefixed = (name: string, entries: readonly Entry[]): Entry[] =>
	entries.map((e) => ({ ...e, text: `${name}: ${e.text}` }));

export const regionReportBody = (
	replies: readonly RegionAnswer[],
	now: Date,
): string => {
	const at = now.getTime();
	const sessions = replies.map((r) => r.session);
	const fallback = averageTaskMs(sessions);
	const past: Entry[] = [];
	const future: Entry[] = [];
	const finishes: number[] = [];
	const parts = replies.map(({ session, answer }) => {
		const parsed = answer.ok ? parseReport(answer.answer) : null;
		const body = answer.ok
			? (parsed && sectionsText(parsed)) || answer.answer.trim()
			: `_No answer: ${answer.error}_`;
		past.push(...prefixed(session.name, pastEntries(session, at)));
		const predicted = futureEntries(session, parsed?.plan ?? [], at, fallback);
		future.push(...prefixed(session.name, predicted.entries));
		if (predicted.finish !== null) finishes.push(predicted.finish);
		return `**${session.name}**\n\n${body}`;
	});
	past.sort((a, b) => a.at - b.at);
	future.sort((a, b) => a.at - b.at);
	return [
		...parts,
		statsText(sessions, now),
		timelineText(
			past.slice(-maxPast),
			at,
			future,
			finishes.length > 0 ? Math.max(...finishes) : null,
		),
	].join("\n\n");
};
