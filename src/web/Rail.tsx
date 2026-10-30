import {
	Gauge,
	ListFilter,
	MessagesSquare,
	PanelRightClose,
	Search,
} from "lucide-preact";
import type { JSX } from "preact";
import type { NodeRef } from "../shared/types.ts";
import { SearchView } from "./SearchView.tsx";
import { StatusView } from "./StatusView.tsx";
import {
	activityFilter,
	board,
	hoveredMessage,
	litMessage,
	now,
	type RailView,
	railView,
	search,
	selectedMessage,
	sessionsById,
	subagentsById,
	workingSubagentsOnly,
} from "./state.ts";
import { relativeTime } from "./time.ts";
import { UsageView, usageGlance } from "./Usage.tsx";
import { usage } from "./usage.ts";

export function nodeName(ref: NodeRef): string {
	if (ref.kind === "session")
		return sessionsById.value.get(ref.id)?.name ?? "Unknown session";
	const agent = subagentsById.value.get(ref.id);
	return agent ? agent.type : "Unknown agent";
}

const views: {
	id: RailView;
	title: string;
	icon: typeof Search;
}[] = [
	{ id: "search", title: "Search", icon: Search },
	{ id: "status", title: "Status", icon: ListFilter },
	{ id: "usage", title: "Usage", icon: Gauge },
	{ id: "messages", title: "Messages", icon: MessagesSquare },
];

function toggleView(view: RailView): void {
	railView.value = railView.value === view ? null : view;
}

function Badge(props: { view: RailView }): JSX.Element | null {
	switch (props.view) {
		case "search":
			return search.value.trim() ? <span class="rail-dot" /> : null;
		case "status":
			return activityFilter.value.size > 0 || workingSubagentsOnly.value ? (
				<span class="rail-dot" />
			) : null;
		case "usage": {
			const current = usage.value;
			if (!current) return null;
			const { level, stale } = usageGlance(current);
			return level === "normal" && !stale ? null : (
				<span class={`rail-dot usage-${level}${stale ? " usage-stale" : ""}`} />
			);
		}
		case "messages": {
			const count = board.value?.messages.length ?? 0;
			return count > 0 ? <span class="rail-badge num">{count}</span> : null;
		}
	}
}

function hint(view: RailView, title: string): string {
	switch (view) {
		case "search":
			return search.value.trim() ? `${title}, filtering the board` : title;
		case "status":
			return activityFilter.value.size > 0 || workingSubagentsOnly.value
				? `${title}, filtering the board`
				: title;
		case "usage": {
			const current = usage.value;
			return current ? usageGlance(current).label : title;
		}
		case "messages": {
			const count = board.value?.messages.length ?? 0;
			return count > 0 ? `${title}, ${count}` : title;
		}
	}
}

function Body(props: { view: RailView }): JSX.Element | null {
	switch (props.view) {
		case "search":
			return <SearchView />;
		case "status":
			return <StatusView />;
		case "usage":
			return <UsageView />;
		case "messages":
			return <Messages />;
	}
}

export function Rail() {
	const open = railView.value;
	const shown = views.filter((v) => v.id !== "usage" || usage.value);
	const active = shown.find((v) => v.id === open);
	return (
		<aside class={`rail${active ? " open" : ""}`} aria-label="Sidebar">
			{active && (
				<section class="rail-panel" aria-label={active.title}>
					<header class="rail-head">
						<h2 class="rail-title">{active.title}</h2>
						<button
							type="button"
							class="rail-close icon-button"
							onClick={() => {
								railView.value = null;
							}}
							aria-label="Close the sidebar"
							title="Close the sidebar"
						>
							<PanelRightClose size={16} />
						</button>
					</header>
					<div class="rail-body" data-scrollable>
						<Body view={active.id} />
					</div>
				</section>
			)}
			<nav class="rail-bar" aria-label="Sidebar views">
				{shown.map(({ id, title, icon: Icon }) => (
					<button
						key={id}
						type="button"
						class="rail-tab"
						aria-pressed={open === id}
						aria-label={hint(id, title)}
						title={hint(id, title)}
						onClick={() => toggleView(id)}
					>
						<Icon size={18} aria-hidden="true" />
						<Badge view={id} />
					</button>
				))}
			</nav>
		</aside>
	);
}

function Messages(): JSX.Element {
	const messages = [...(board.value?.messages ?? [])].sort(
		(a, b) => b.at - a.at,
	);
	if (messages.length === 0)
		return (
			<p class="rail-empty">
				No messages yet. When one session messages another, it shows up here and
				travels along an arc on the board.
			</p>
		);
	return (
		<ul class="messages">
			{messages.map((m) => (
				<li key={m.id}>
					<button
						type="button"
						class={`message${litMessage.value === m.id ? " lit" : ""}`}
						aria-pressed={selectedMessage.value === m.id}
						onMouseEnter={() => {
							hoveredMessage.value = m.id;
						}}
						onMouseLeave={() => {
							hoveredMessage.value = null;
						}}
						onClick={() => {
							selectedMessage.value =
								selectedMessage.value === m.id ? null : m.id;
						}}
					>
						<span class="message-route">
							<span class="message-name">{nodeName(m.from)}</span>
							<span class="message-arrow" aria-hidden="true">
								→
							</span>
							<span class="message-name">{nodeName(m.to)}</span>
							<time class="message-time num">
								{relativeTime(m.at, now.value)}
							</time>
						</span>
						<span class="message-summary">{m.summary}</span>
					</button>
				</li>
			))}
		</ul>
	);
}
