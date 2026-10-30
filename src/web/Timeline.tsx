import "./timeline.css";
import { useLayoutEffect, useRef } from "preact/hooks";
import { relativeTime } from "./time.ts";
import {
	eventRows,
	type Lane,
	latestFinish,
	marksOf,
	minutesBetween,
	windowOf,
} from "./timeline.ts";

const clock = (at: number): string =>
	new Date(at).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
	});

export function finishText(finish: number, now: number): string {
	const left = relativeTime(now, finish);
	return `Done ~${clock(finish)}${left === "now" ? "" : ` · in ${left}`}`;
}

const eventRowEm = 1.5;

function TimelineEvents(props: {
	lane: Lane;
	minuteEm: number;
	at: (time: number) => string;
}) {
	const { events } = props.lane;
	const rows = eventRows(events, props.minuteEm);
	return (
		<ol
			class="timeline-events"
			style={{ height: `${(Math.max(-1, ...rows) + 1) * eventRowEm}em` }}
		>
			{events.map((event, index) => (
				<li
					key={`${event.at}-${index}`}
					class="timeline-event"
					title={`${clock(event.at)} ${event.text}`}
					style={{
						left: props.at(event.at),
						top: `${(rows[index] ?? 0) * eventRowEm}em`,
					}}
				>
					{event.text}
				</li>
			))}
		</ol>
	);
}

export function Timeline(props: {
	lanes: readonly Lane[];
	now: number;
	label: string;
	minuteEm: number;
	labelled?: boolean;
}) {
	const { lanes, now } = props;
	const scroller = useRef<HTMLDivElement>(null);
	const nowLine = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const el = scroller.current;
		const line = nowLine.current;
		if (el && line) el.scrollLeft = line.offsetLeft - el.clientWidth * 0.6;
	}, []);
	if (lanes.length === 0) return null;
	const range = windowOf(lanes, now);
	const at = (time: number) =>
		`calc(var(--tl-minute) * ${minutesBetween(range.start, time)})`;
	const length = (from: number, to: number) =>
		`calc(var(--tl-minute) * ${Math.max(0, minutesBetween(from, to))})`;
	const finish = latestFinish(lanes);
	return (
		<section
			class="timeline"
			aria-label={props.label}
			style={{ "--tl-minute": `${props.minuteEm}em` }}
		>
			<div class="timeline-head">
				<span>Timeline</span>
				{finish !== null && (
					<span class="timeline-finish num">{finishText(finish, now)}</span>
				)}
			</div>
			<div class="timeline-scroll" ref={scroller} data-scrollable>
				<div
					class="timeline-track"
					style={{ width: length(range.start, range.end) }}
				>
					<div class="timeline-axis" aria-hidden="true">
						{marksOf(range).map((mark) => (
							<span
								key={mark}
								class="timeline-mark num"
								style={{ left: at(mark) }}
							>
								{clock(mark)}
							</span>
						))}
					</div>
					<span class="timeline-now" ref={nowLine} style={{ left: at(now) }} />
					{lanes.map((lane) => (
						<div key={lane.key} class="timeline-lane">
							<span class="timeline-label" title={lane.label}>
								{lane.label}
							</span>
							{lane.spans.map((span, index) => (
								<span
									key={index}
									class={`timeline-span span-${span.kind}`}
									title={span.title}
									style={{
										left: at(span.start),
										width: length(span.start, span.end),
									}}
								/>
							))}
							{props.labelled ? (
								<TimelineEvents lane={lane} minuteEm={props.minuteEm} at={at} />
							) : (
								lane.events.map((event, index) => (
									<span
										key={`${event.at}-${index}`}
										class="timeline-tick"
										title={`${clock(event.at)} ${event.text}`}
										style={{ left: at(event.at) }}
									/>
								))
							)}
							{lane.finish !== null && (
								<span
									class="timeline-lane-finish num"
									style={{ left: at(lane.finish) }}
									title={finishText(lane.finish, now)}
								>
									~{clock(lane.finish)}
								</span>
							)}
						</div>
					))}
				</div>
			</div>
		</section>
	);
}
