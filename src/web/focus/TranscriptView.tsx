import { BookOpen, MessageSquare, Wrench } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { TranscriptEntry } from "../../shared/types.ts";
import { transcriptUrl } from "./paths.ts";

const pollMs = 2000;
const bottomSlackPx = 48;

function Entry(props: { entry: TranscriptEntry }): JSX.Element {
	const { role, text } = props.entry;
	if (role === "tool")
		return (
			<div class="focus-entry focus-entry-tool">
				<Wrench size={12} />
				<span>{text}</span>
			</div>
		);
	if (role === "peer")
		return (
			<div class="focus-entry focus-entry-peer">
				<div class="focus-entry-label">
					<MessageSquare size={12} />
					Peer message
				</div>
				<div class="focus-entry-text">{text}</div>
			</div>
		);
	return (
		<div class={`focus-entry focus-entry-${role}`}>
			<div class="focus-entry-text">{text}</div>
		</div>
	);
}

function sameTranscript(a: TranscriptEntry[], b: TranscriptEntry[]): boolean {
	return (
		a.length === b.length &&
		a.at(-1)?.at === b.at(-1)?.at &&
		a.at(-1)?.text === b.at(-1)?.text
	);
}

export function TranscriptView(props: { id: string }): JSX.Element {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let stopped = false;
		let timer = 0;
		const poll = async () => {
			try {
				const response = await fetch(transcriptUrl(props.id, 200));
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const next = (await response.json()) as TranscriptEntry[];
				if (stopped) return;
				setError(null);
				setEntries((previous) =>
					previous && sameTranscript(previous, next) ? previous : next,
				);
			} catch (caught) {
				if (!stopped) setError(String(caught));
			}
			if (!stopped) timer = window.setTimeout(poll, pollMs);
		};
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [props.id]);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [entries]);

	const trackPinned = () => {
		const element = scroller.current;
		if (!element) return;
		pinned.current =
			element.scrollHeight - element.scrollTop - element.clientHeight <
			bottomSlackPx;
	};

	return (
		<div class="focus-transcript">
			<div class="focus-callout">
				<BookOpen size={14} />
				<span>
					Started in a terminal, so it can only be read here. Sessions you start
					from the board can be driven from here.
				</span>
			</div>
			<div
				class="focus-transcript-scroll"
				ref={scroller}
				onScroll={trackPinned}
			>
				<div class="focus-transcript-body">
					{entries?.map((entry, index) => (
						<Entry key={`${entry.at}-${index}`} entry={entry} />
					))}
					{entries?.length === 0 && (
						<p class="focus-muted focus-transcript-empty">
							Nothing in this transcript yet.
						</p>
					)}
					{entries === null && !error && (
						<p class="focus-muted focus-transcript-empty">Loading…</p>
					)}
				</div>
			</div>
			{error && (
				<div class="focus-transcript-error" role="status">
					Couldn't refresh the transcript ({error}). Retrying.
				</div>
			)}
		</div>
	);
}
