import "./report.css";
import { signal } from "@preact/signals";
import { Maximize2, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type {
	ReportPart,
	ReportSectionKey,
	StatusReport,
} from "../shared/types.ts";
import { activityLabel } from "./activity.tsx";
import { useRestoreFocus } from "./restoreFocus.ts";
import { Timeline } from "./Timeline.tsx";
import { relativeTime } from "./time.ts";

export const openReport = signal<string | null>(null);

const clock = (at: number): string =>
	new Date(at).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
	});

const minute = 60_000;

export function durationText(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / minute));
	const hours = Math.floor(minutes / 60);
	if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

export function compact(n: number): string {
	const short = (value: number, unit: string) =>
		`${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
	if (n >= 999_950) return short(n / 1_000_000, "M");
	if (n >= 1000) return short(n / 1000, "k");
	return String(Math.round(n));
}

type Totals = {
	done: number;
	active: number;
	pending: number;
	total: number;
	tokens: number | null;
	output: number | null;
	started: number;
	finish: number | null;
};

export function totalsOf(report: StatusReport): Totals {
	const sum = (pick: (p: ReportPart) => number) =>
		report.parts.reduce((total, part) => total + pick(part), 0);
	const known = report.parts.flatMap((p) => (p.tokens ? [p.tokens] : []));
	const finishes = report.parts.flatMap((p) =>
		p.finish === null ? [] : [p.finish],
	);
	const done = sum((p) => p.tasks.done);
	const active = sum((p) => p.tasks.active);
	const pending = sum((p) => p.tasks.pending);
	return {
		done,
		active,
		pending,
		total: done + active + pending,
		tokens:
			known.length === 0
				? null
				: known.reduce(
						(t, k) => t + k.input + k.output + k.cacheRead + k.cacheWrite,
						0,
					),
		output: known.length === 0 ? null : known.reduce((t, k) => t + k.output, 0),
		started: Math.min(report.at, ...report.parts.map((p) => p.startedAt)),
		finish: finishes.length > 0 ? Math.max(...finishes) : null,
	};
}

function Ring(props: { done: number; total: number }): JSX.Element {
	const r = 15;
	const c = 2 * Math.PI * r;
	const share = props.total === 0 ? 0 : props.done / props.total;
	return (
		<svg class="report-ring" viewBox="0 0 36 36" aria-hidden="true">
			<circle cx="18" cy="18" r={r} class="report-ring-track" />
			<circle
				cx="18"
				cy="18"
				r={r}
				class="report-ring-fill"
				stroke-dasharray={`${c * share} ${c}`}
				transform="rotate(-90 18 18)"
			/>
			<text x="18" y="21.5" text-anchor="middle" class="report-ring-text">
				{Math.round(share * 100)}%
			</text>
		</svg>
	);
}

function Tiles(props: { report: StatusReport; totals: Totals }): JSX.Element {
	const { report, totals } = props;
	return (
		<div class="report-tiles">
			<div class="report-tile">
				<Ring done={totals.done} total={totals.total} />
				<div>
					<span class="report-tile-value num">
						{totals.done}/{totals.total}
					</span>
					<span class="report-tile-label">tasks done</span>
				</div>
			</div>
			<div class="report-tile">
				<div>
					<span class="report-tile-value num">
						{durationText(report.at - totals.started)}
					</span>
					<span class="report-tile-label">running</span>
				</div>
			</div>
			<div class="report-tile">
				<div>
					<span class="report-tile-value num">
						{totals.finish === null ? "—" : `~${clock(totals.finish)}`}
					</span>
					<span class="report-tile-label">
						{totals.finish === null
							? "completion unknown"
							: `predicted done · ${durationText(totals.finish - report.at)} left`}
					</span>
				</div>
			</div>
			<div class="report-tile">
				<div>
					<span class="report-tile-value num">
						{totals.tokens === null ? "—" : compact(totals.tokens)}
					</span>
					<span class="report-tile-label">
						{totals.output === null
							? "tokens unknown"
							: `tokens · ${compact(totals.output)} output`}
					</span>
				</div>
			</div>
		</div>
	);
}

const chart = { w: 560, h: 150, left: 28, right: 10, top: 10, bottom: 22 };

function Burnup(props: { report: StatusReport; totals: Totals }): JSX.Element {
	const { report, totals } = props;
	const start = totals.started;
	const end = Math.max(report.at, totals.finish ?? report.at) + 5 * minute;
	const top = Math.max(1, totals.total);
	const x = (at: number) =>
		chart.left +
		((at - start) / (end - start)) * (chart.w - chart.left - chart.right);
	const y = (n: number) =>
		chart.h - chart.bottom - (n / top) * (chart.h - chart.top - chart.bottom);
	const points = report.parts
		.flatMap((part) => part.burnup.slice(1).map((p) => p.at))
		.sort((a, b) => a - b);
	const path = [
		`M${x(start)},${y(0)}`,
		...points.map((at, i) => `H${x(at)}V${y(i + 1)}`),
		`H${x(report.at)}`,
	].join("");
	const projection =
		totals.finish === null
			? null
			: `M${x(report.at)},${y(totals.done)}L${x(totals.finish)},${y(totals.total)}`;
	const ticks = [start, report.at, ...(totals.finish ? [totals.finish] : [])];
	return (
		<figure class="report-figure">
			<figcaption>Progress</figcaption>
			<svg
				class="report-burnup"
				viewBox={`0 0 ${chart.w} ${chart.h}`}
				role="img"
				aria-label={`${totals.done} of ${totals.total} tasks done`}
			>
				<line
					x1={chart.left}
					x2={chart.w - chart.right}
					y1={y(totals.total)}
					y2={y(totals.total)}
					class="report-goal-line"
				/>
				<text x={chart.left - 4} y={y(totals.total) + 4} class="report-axis">
					{totals.total}
				</text>
				<text x={chart.left - 4} y={y(0) + 4} class="report-axis">
					0
				</text>
				<path d={`${path}V${y(0)}H${x(start)}Z`} class="report-burnup-area" />
				<path d={path} class="report-burnup-line" />
				{projection && <path d={projection} class="report-burnup-plan" />}
				<line
					x1={x(report.at)}
					x2={x(report.at)}
					y1={chart.top}
					y2={chart.h - chart.bottom}
					class="report-now-line"
				/>
				{ticks.map((at) => (
					<text
						key={at}
						x={x(at)}
						y={chart.h - 6}
						class="report-axis report-axis-x"
					>
						{at === report.at ? "now" : clock(at)}
					</text>
				))}
			</svg>
		</figure>
	);
}

function StatusBars(props: { parts: readonly ReportPart[] }): JSX.Element {
	return (
		<figure class="report-figure">
			<figcaption>Tasks by session</figcaption>
			<ul class="report-bars">
				{props.parts.map((part, index) => {
					const { done, active, pending } = part.tasks;
					const total = Math.max(1, done + active + pending);
					return (
						<li key={`${part.name}-${index}`} class="report-bar-row">
							<span class="report-bar-name" title={part.name}>
								{part.name}
							</span>
							<span class="report-bar" aria-hidden="true">
								<span class="bar-done" style={{ flexGrow: done / total }} />
								<span class="bar-active" style={{ flexGrow: active / total }} />
								<span
									class="bar-pending"
									style={{ flexGrow: pending / total }}
								/>
							</span>
							<span class="report-bar-count num">
								{done}/{done + active + pending}
							</span>
						</li>
					);
				})}
			</ul>
			<div class="report-legend" aria-hidden="true">
				<span class="legend-done">done</span>
				<span class="legend-active">in progress</span>
				<span class="legend-pending">to do</span>
			</div>
		</figure>
	);
}

const sectionTitles: Record<ReportSectionKey, string> = {
	goal: "Goal",
	done: "Done so far",
	left: "Left",
	needs: "Needs you",
};

const sectionOrder: readonly ReportSectionKey[] = [
	"goal",
	"done",
	"left",
	"needs",
];

function Part(props: { part: ReportPart; named: boolean }): JSX.Element {
	const { part } = props;
	const planTotal = part.plan.reduce((t, s) => t + s.ms, 0);
	return (
		<section class="report-part">
			{props.named && (
				<h3 class={`report-part-name act-${part.activity}`}>
					{part.name}
					<span class="report-part-activity">
						{activityLabel[part.activity]}
					</span>
				</h3>
			)}
			{part.error && <p class="report-error">No answer: {part.error}</p>}
			{part.answer && <p class="report-answer">{part.answer}</p>}
			<div class="report-sections">
				{sectionOrder.map((key) => {
					const text = part.sections[key];
					return text ? (
						<div key={key} class={`report-section section-${key}`}>
							<h4>{sectionTitles[key]}</h4>
							<p>{text}</p>
						</div>
					) : null;
				})}
			</div>
			{part.plan.length > 0 && (
				<div class="report-plan">
					<h4>
						Plan <span class="num">· {durationText(planTotal)}</span>
					</h4>
					<ol>
						{part.plan.map((step, index) => (
							<li key={`${index}-${step.text}`}>
								<span
									class="report-plan-bar"
									style={{
										width: `${Math.max(4, (step.ms / Math.max(1, planTotal)) * 100)}%`,
									}}
								/>
								<span class="report-plan-text">{step.text}</span>
								<span class="report-plan-ms num">{durationText(step.ms)}</span>
							</li>
						))}
					</ol>
				</div>
			)}
		</section>
	);
}

function Shots(props: { report: StatusReport }): JSX.Element | null {
	if (props.report.shots.length === 0) return null;
	return (
		<figure class="report-figure">
			<figcaption>Screenshots</figcaption>
			<div class="report-shots">
				{props.report.shots.map((shot) => (
					<a
						key={shot.url}
						class="report-shot"
						href={shot.url}
						target="_blank"
						rel="noreferrer"
						title={shot.caption}
					>
						<img src={shot.url} alt={shot.caption} loading="lazy" />
						<span class="num">
							{clock(shot.at)} · {shot.caption}
						</span>
					</a>
				))}
			</div>
		</figure>
	);
}

export function ReportTimeline(props: {
	report: StatusReport;
	minuteEm?: number;
}): JSX.Element {
	const { report } = props;
	return (
		<Timeline
			key={report.at}
			lanes={report.lanes}
			now={report.at}
			label={`${report.title} timeline`}
			minuteEm={props.minuteEm ?? 1.2}
			labelled
		/>
	);
}

export function ReportHeader(props: {
	report: StatusReport;
	onOpen?: () => void;
}): JSX.Element {
	const { report } = props;
	return (
		<header class="report-head">
			<div class="report-title">
				<span class="report-kicker num">
					Status report · {clock(report.at)}
				</span>
				<h2>{report.title}</h2>
			</div>
			{props.onOpen && (
				<button
					type="button"
					class="report-open"
					title="Open the full report"
					aria-label={`Open the full status report for ${report.title}`}
					onClick={props.onOpen}
				>
					<Maximize2 size={14} aria-hidden="true" />
				</button>
			)}
		</header>
	);
}

export function ReportDashboard(props: {
	report: StatusReport;
	onOpen?: () => void;
}): JSX.Element {
	const { report } = props;
	const totals = totalsOf(report);
	const needs = report.parts.flatMap((p) =>
		p.sections.needs ? [{ name: p.name, text: p.sections.needs }] : [],
	);
	return (
		<div class="report-dashboard">
			<ReportHeader report={report} onOpen={props.onOpen} />
			{needs.length > 0 && (
				<div class="report-needs" role="note">
					<strong>Needs you</strong>
					{needs.map((n) => (
						<p key={n.name}>
							{report.parts.length > 1 && <b>{n.name}: </b>}
							{n.text}
						</p>
					))}
				</div>
			)}
			<Tiles report={report} totals={totals} />
			<div class="report-charts">
				<Burnup report={report} totals={totals} />
				<StatusBars parts={report.parts} />
			</div>
			<ReportTimeline report={report} />
			<Shots report={report} />
			{report.parts.map((part, index) => (
				<Part
					key={`${part.name}-${index}`}
					part={part}
					named={report.parts.length > 1}
				/>
			))}
		</div>
	);
}

export function ReportModal(props: {
	report: StatusReport | null;
	onClose: () => void;
}): JSX.Element | null {
	const dialog = useRef<HTMLDialogElement>(null);
	const open = props.report !== null;
	useRestoreFocus(open);
	useEffect(() => {
		if (open) dialog.current?.showModal();
	}, [open]);
	if (!props.report) return null;
	const age = relativeTime(props.report.at, Date.now());
	return (
		<dialog
			class="report-modal"
			ref={dialog}
			onClose={props.onClose}
			onKeyDown={(event) => {
				if (event.key === "Escape") event.stopPropagation();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) props.onClose();
			}}
			aria-label={`Status report for ${props.report.title}`}
		>
			<div class="report-modal-body">
				<button
					type="button"
					class="report-close"
					aria-label="Close the status report"
					onClick={props.onClose}
				>
					<X size={16} aria-hidden="true" />
				</button>
				<ReportDashboard report={props.report} />
				<p class="report-age">
					Reported {age === "now" ? "just now" : `${age} ago`}
				</p>
			</div>
		</dialog>
	);
}
