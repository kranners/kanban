import "./archive.css";
import { Search } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
	ArchiveEntry,
	ArchiveKind,
	ArchiveListing,
	ArchiveOutcome,
} from "../shared/types.ts";
import { renderMarkdown } from "./markdown.ts";

// The sidebar's Archive: every card and session the board archived once
// its work was over, newest first, searchable and filterable, each opening
// to its report and log read-only, with Restore to put a card back.

const kindNames: Record<ArchiveKind, string> = {
	change: "Change",
	desk: "Desk session",
	session: "Board session",
	job: "Scheduled job",
	conversation: "Conversation",
};

const outcomeNames: Record<ArchiveOutcome, string> = {
	done: "Done",
	failed: "Failed",
	superseded: "Superseded",
};

export type ArchiveFilters = {
	q: string;
	kind: ArchiveKind | "";
	project: string;
	outcome: ArchiveOutcome | "";
	from: string;
	to: string;
};

/** The query string for the archive's filters, the empty ones left out. */
export function archiveQuery(filters: ArchiveFilters): string {
	const params = new URLSearchParams();
	if (filters.q.trim()) params.set("q", filters.q.trim());
	if (filters.kind) params.set("kind", filters.kind);
	if (filters.project) params.set("project", filters.project);
	if (filters.outcome) params.set("outcome", filters.outcome);
	if (filters.from) {
		params.set("from", String(new Date(`${filters.from}T00:00:00`).getTime()));
	}
	if (filters.to) {
		params.set("to", String(new Date(`${filters.to}T23:59:59.999`).getTime()));
	}
	const query = params.toString();
	return query ? `?${query}` : "";
}

/** How long something ran, such as "2 h 5 min" or "40 s". */
export function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
	return `${Math.round(hours / 24)} days`;
}

const when = (at: number) =>
	new Date(at).toLocaleString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit",
	});

const empty: ArchiveFilters = {
	q: "",
	kind: "",
	project: "",
	outcome: "",
	from: "",
	to: "",
};

function Row(props: {
	entry: ArchiveEntry;
	open: boolean;
	onToggle: () => void;
	onRestored: () => void;
}): JSX.Element {
	const { entry } = props;
	const [error, setError] = useState<string | null>(null);
	const ran =
		entry.startedAt !== undefined
			? duration(entry.finishedAt - entry.startedAt)
			: null;
	const restore = async () => {
		setError(null);
		const response = await fetch(
			`/api/archive/${encodeURIComponent(entry.id)}/restore`,
			{ method: "POST" },
		).catch(() => null);
		const body = (await response?.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
		} | null;
		if (body?.ok) props.onRestored();
		else setError(body?.error ?? "Could not restore it");
	};
	return (
		<li class={`archive-row outcome-${entry.outcome}`}>
			<button
				type="button"
				class="archive-head"
				aria-expanded={props.open}
				onClick={props.onToggle}
			>
				<span class="archive-title">{entry.title}</span>
				<span class="archive-meta">
					<span class="archive-kind">{kindNames[entry.kind]}</span>
					<span class="archive-project">{entry.project}</span>
					<span class={`archive-outcome outcome-${entry.outcome}`}>
						{outcomeNames[entry.outcome]}
					</span>
				</span>
				{entry.task && <span class="archive-task">{entry.task}</span>}
				<span class="archive-times num">
					{entry.startedAt !== undefined && `${when(entry.startedAt)} → `}
					{when(entry.finishedAt)}
					{ran && ` · ran ${ran}`}
				</span>
			</button>
			{props.open && (
				<div class="archive-detail">
					{entry.parent && (
						<p class="archive-line">Asked by {entry.parent.title}</p>
					)}
					{entry.mission && (
						<p class="archive-line">
							<span class="butler-chip butler-chip-mission">
								Mission {entry.mission.id}
							</span>{" "}
							{entry.mission.covers}
						</p>
					)}
					{entry.machines && entry.machines.length > 0 && (
						<p class="archive-line">
							{entry.machines.map((m) => (
								<span key={m} class="butler-chip">
									{m}
								</span>
							))}
						</p>
					)}
					{(entry.discord || entry.session) && (
						<p class="archive-line archive-links">
							{entry.discord && (
								<a
									href={entry.discord}
									target="_blank"
									rel="noopener noreferrer"
								>
									Discord thread
								</a>
							)}
							{entry.session && (
								<a
									href={entry.session}
									target="_blank"
									rel="noopener noreferrer"
								>
									Session
								</a>
							)}
						</p>
					)}
					{entry.report && (
						<div class="archive-report">{renderMarkdown(entry.report)}</div>
					)}
					{entry.log && entry.log.length > 0 && (
						<ol class="archive-log">
							{entry.log.map((event) => (
								<li
									key={`${event.at}-${event.kind}`}
									class={`log-${event.kind}`}
								>
									<span class="archive-log-kind">{event.kind}</span>{" "}
									{event.text}
								</li>
							))}
						</ol>
					)}
					{entry.compacted && (
						<p class="rail-empty">
							Compacted after 90 days: only this summary is kept.
						</p>
					)}
					{entry.card && (
						<button type="button" class="archive-restore" onClick={restore}>
							Restore to board
						</button>
					)}
					{error && <p class="archive-error">{error}</p>}
				</div>
			)}
		</li>
	);
}

export function ArchiveView(): JSX.Element {
	const [filters, setFilters] = useState<ArchiveFilters>(empty);
	const [listing, setListing] = useState<ArchiveListing | null>(null);
	const [failed, setFailed] = useState(false);
	const [open, setOpen] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const query = archiveQuery(filters);

	useEffect(() => {
		const abort = new AbortController();
		const load = () =>
			fetch(`/api/archive${query}`, { signal: abort.signal })
				.then((r) => (r.ok ? (r.json() as Promise<ArchiveListing>) : null))
				.then((body) => {
					setFailed(body === null);
					if (body) setListing(body);
				})
				.catch(() => {
					if (!abort.signal.aborted) setFailed(true);
				});
		void load();
		const timer = setInterval(load, 30_000);
		return () => {
			abort.abort();
			clearInterval(timer);
		};
	}, [query, reload]);

	const set = (patch: Partial<ArchiveFilters>) =>
		setFilters((f) => ({ ...f, ...patch }));
	const busiest = Math.max(1, ...(listing?.days.map((d) => d.count) ?? [1]));

	return (
		<div class="archive-view">
			<label class="search">
				<Search size={14} aria-hidden="true" />
				<input
					type="search"
					placeholder="Search the archive"
					aria-label="Search the archive"
					value={filters.q}
					onInput={(e) => set({ q: e.currentTarget.value })}
				/>
			</label>
			<div class="archive-filters">
				<select
					aria-label="Kind"
					value={filters.kind}
					onChange={(e) => set({ kind: e.currentTarget.value as ArchiveKind })}
				>
					<option value="">Every kind</option>
					{Object.entries(kindNames).map(([id, name]) => (
						<option key={id} value={id}>
							{name}
						</option>
					))}
				</select>
				<select
					aria-label="Project"
					value={filters.project}
					onChange={(e) => set({ project: e.currentTarget.value })}
				>
					<option value="">Every project</option>
					{(listing?.projects ?? []).map((p) => (
						<option key={p} value={p}>
							{p}
						</option>
					))}
				</select>
				<select
					aria-label="Outcome"
					value={filters.outcome}
					onChange={(e) =>
						set({ outcome: e.currentTarget.value as ArchiveOutcome })
					}
				>
					<option value="">Every outcome</option>
					{Object.entries(outcomeNames).map(([id, name]) => (
						<option key={id} value={id}>
							{name}
						</option>
					))}
				</select>
				<input
					type="date"
					aria-label="From"
					value={filters.from}
					onInput={(e) => set({ from: e.currentTarget.value })}
				/>
				<input
					type="date"
					aria-label="To"
					value={filters.to}
					onInput={(e) => set({ to: e.currentTarget.value })}
				/>
			</div>
			{failed && <p class="archive-error">The archive could not be read.</p>}
			{listing && listing.days.length > 0 && (
				<ol class="archive-days" aria-label="Finished per day">
					{listing.days.slice(0, 14).map((d) => (
						<li key={d.day} title={`${d.count} on ${d.day}`}>
							<span class="archive-day num">{d.day.slice(5)}</span>
							<span
								class="archive-bar"
								style={{ width: `${(d.count / busiest) * 100}%` }}
							/>
							<span class="archive-count num">{d.count}</span>
						</li>
					))}
				</ol>
			)}
			{listing && (
				<p class="rail-section num" aria-live="polite">
					{listing.total === 0
						? "Nothing archived matches"
						: `${listing.total} archived${listing.total > listing.entries.length ? `, newest ${listing.entries.length} shown` : ""}`}
				</p>
			)}
			<ul class="archive-list">
				{listing?.entries.map((entry) => (
					<Row
						key={entry.id}
						entry={entry}
						open={open === entry.id}
						onToggle={() => setOpen(open === entry.id ? null : entry.id)}
						onRestored={() => {
							setOpen(null);
							setReload((n) => n + 1);
						}}
					/>
				))}
			</ul>
		</div>
	);
}
