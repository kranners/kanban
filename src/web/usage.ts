import { signal } from "@preact/signals";
import type { Usage, UsageSample } from "../shared/types.ts";

export const usage = signal<Usage | null>(null);

export type Severity = "normal" | "warning" | "critical";

export const severity = (percent: number): Severity =>
	percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal";

export const chartSpanMs = 7 * 86_400_000;
const gapMs = 20 * 60_000;

export type Frame = { from: number; to: number; width: number; height: number };

export const xOf = (at: number, frame: Frame): number =>
	((at - frame.from) / (frame.to - frame.from)) * frame.width;

export const yOf = (percent: number, frame: Frame): number =>
	frame.height - (Math.min(100, Math.max(0, percent)) / 100) * frame.height;

const round = (value: number) => Math.round(value * 10) / 10;

export function linePath(
	samples: readonly UsageSample[],
	series: "session" | "week",
	frame: Frame,
): string {
	let previous: number | null = null;
	const commands: string[] = [];
	for (const sample of samples) {
		if (sample.at < frame.from || sample.at > frame.to) continue;
		const move = previous === null || sample.at - previous > gapMs;
		commands.push(
			`${move ? "M" : "L"}${round(xOf(sample.at, frame))} ${round(yOf(sample[series], frame))}`,
		);
		previous = sample.at;
	}
	return commands.join(" ");
}

export function nearestSample(
	samples: readonly UsageSample[],
	at: number,
): UsageSample | null {
	let best: UsageSample | null = null;
	for (const sample of samples) {
		if (!best || Math.abs(sample.at - at) < Math.abs(best.at - at)) {
			best = sample;
		}
	}
	return best;
}

export function untilReset(resetsAt: number, now: number): string {
	const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}
