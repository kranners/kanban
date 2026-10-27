import "./usage.css";
import { Gauge, TriangleAlert } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { UsageSample, UsageWindow } from "../shared/types.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";
import {
	chartSpanMs,
	type Frame,
	linePath,
	nearestSample,
	severity,
	untilReset,
	usage,
	xOf,
	yOf,
} from "./usage.ts";

const series = [
	{ key: "week", label: "Week" },
	{ key: "session", label: "5-hour session" },
] as const;

const percent = (window: UsageWindow | null) =>
	window ? `${Math.round(window.percent)}%` : "–";

const worst = (...windows: (UsageWindow | null)[]) =>
	severity(Math.max(0, ...windows.map((window) => window?.percent ?? 0)));

const clock = (at: number) =>
	new Date(at).toLocaleString(undefined, {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});

const sparkFrame = (to: number): Frame => ({
	from: to - chartSpanMs,
	to,
	width: 40,
	height: 14,
});

export function UsagePill(): JSX.Element | null {
	const current = usage.value;
	if (!current) return null;
	const { session, week, samples, error } = current;
	const level = worst(session, week);
	const at = now.value;
	return (
		<>
			<button
				type="button"
				class={`pill usage-pill usage-${level}${error ? " usage-stale" : ""}`}
				popovertarget="usage-popover"
				aria-label={`Claude usage: 5-hour session ${percent(session)}, week ${percent(week)}${error ? `; ${error}` : ""}`}
				title={error ?? "Claude usage"}
			>
				{level === "normal" && !error ? (
					<Gauge size={13} aria-hidden="true" />
				) : (
					<TriangleAlert size={13} strokeWidth={2.25} aria-hidden="true" />
				)}
				<span class="usage-reading">
					<span class="usage-name">5h</span>
					<span class="num">{percent(session)}</span>
				</span>
				<span class="usage-reading">
					<span class="usage-name">Week</span>
					<span class="num">{percent(week)}</span>
				</span>
				<svg
					class="usage-spark"
					viewBox="0 0 40 14"
					width="40"
					height="14"
					aria-hidden="true"
				>
					<path d={linePath(samples, "week", sparkFrame(at))} />
				</svg>
			</button>
			<div id="usage-popover" popover="auto" class="usage-popover">
				<h2>Claude usage</h2>
				<dl class="usage-windows">
					{series.map(({ key, label }) => {
						const window = current[key];
						return (
							<div key={key} class={`usage-window series-${key}`}>
								<dt>
									<span class="usage-key" aria-hidden="true" />
									{label}
								</dt>
								<dd>
									<span class="num">{percent(window)}</span>
									{window?.resetsAt != null && (
										<span
											class="usage-reset"
											title={`Resets ${clock(window.resetsAt)}`}
										>
											resets in {untilReset(window.resetsAt, at)}
										</span>
									)}
								</dd>
								<span class="usage-bar" aria-hidden="true">
									<span
										style={{
											width: `${Math.min(100, window?.percent ?? 0)}%`,
										}}
									/>
								</span>
							</div>
						);
					})}
				</dl>
				<UsageChart samples={samples} to={at} />
				<p class={`usage-status${error ? " usage-error" : ""}`}>
					{error ??
						(current.checkedAt
							? `Checked ${ago(current.checkedAt, at)}`
							: "Checking…")}
				</p>
			</div>
		</>
	);
}

const chart = { width: 288, height: 96, left: 30, top: 8, bottom: 18 };

function UsageChart(props: {
	samples: readonly UsageSample[];
	to: number;
}): JSX.Element {
	const [hovered, setHovered] = useState<UsageSample | null>(null);
	const frame: Frame = {
		from: props.to - chartSpanMs,
		to: props.to,
		width: chart.width - chart.left,
		height: chart.height - chart.top - chart.bottom,
	};
	const hover = (event: PointerEvent) => {
		const svg = event.currentTarget as SVGSVGElement;
		const box = svg.getBoundingClientRect();
		const x = ((event.clientX - box.left) / box.width) * chart.width;
		const at =
			frame.from + ((x - chart.left) / frame.width) * (frame.to - frame.from);
		setHovered(nearestSample(props.samples, at, frame));
	};
	return (
		<figure class="usage-chart">
			<svg
				viewBox={`0 0 ${chart.width} ${chart.height}`}
				role="img"
				aria-label="Usage over the last 7 days"
				onPointerMove={hover}
				onPointerLeave={() => setHovered(null)}
			>
				{[0, 50, 100].map((tick) => (
					<g key={tick} class="usage-grid">
						<line
							x1={chart.left}
							x2={chart.width}
							y1={chart.top + yOf(tick, frame)}
							y2={chart.top + yOf(tick, frame)}
						/>
						<text x={chart.left - 6} y={chart.top + yOf(tick, frame) + 3}>
							{tick}%
						</text>
					</g>
				))}
				<text
					class="usage-axis usage-axis-start"
					x={chart.left}
					y={chart.height - 3}
				>
					7 days ago
				</text>
				<text class="usage-axis" x={chart.width} y={chart.height - 3}>
					now
				</text>
				<g transform={`translate(${chart.left} ${chart.top})`}>
					{series.map(({ key }) => (
						<path
							key={key}
							class={`usage-line series-${key}`}
							d={linePath(props.samples, key, frame)}
						/>
					))}
					{hovered && (
						<g class="usage-crosshair">
							<line
								x1={xOf(hovered.at, frame)}
								x2={xOf(hovered.at, frame)}
								y1={0}
								y2={frame.height}
							/>
							{series.map(({ key }) => (
								<circle
									key={key}
									class={`series-${key}`}
									cx={xOf(hovered.at, frame)}
									cy={yOf(hovered[key], frame)}
									r={4}
								/>
							))}
						</g>
					)}
				</g>
			</svg>
			<figcaption>
				{hovered
					? `${clock(hovered.at)} · week ${Math.round(hovered.week)}% · session ${Math.round(hovered.session)}%`
					: props.samples.length > 0
						? "Hover the chart for a reading"
						: "No history yet"}
			</figcaption>
		</figure>
	);
}
