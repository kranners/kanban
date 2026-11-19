import "../web/styles.css";
import "../web/attention.css";
import "../web/butler.css";
import "./sheet.css";
import type { JSX } from "preact";
import { stageNames } from "../shared/projects.ts";
import {
	ButlerCardFootView,
	ButlerChips,
	barName,
} from "../web/butlerCardFace.tsx";
import {
	AuthorChip,
	BusyEdge,
	CardFace,
	StatusBadge,
	StatusIcon,
	StatusRibbon,
} from "../web/CardFace.tsx";
import { CardBody } from "../web/cardBody.tsx";
import type { CardStatus } from "../web/cardFace.ts";
import {
	DashboardBody,
	dateOf,
	LifecycleStrip,
} from "../web/projectDashboardView.tsx";
import { ReportDashboard } from "../web/reportDashboard.tsx";
import { SubagentChipList } from "../web/subagentChipList.tsx";
import { cardSize, type SheetCard, type SheetInput } from "./input.ts";

/** A card at the board's card size, drawn as the board draws one of Butler's thread cards. */
function Card(props: { card: SheetCard; now: number }): JSX.Element {
	const { card, session, view, chips, linked } = props.card;
	return (
		<div
			class="sheet-slot"
			style={{ width: `${cardSize.w}px`, height: `${cardSize.h}px` }}
		>
			<CardFace
				status={view.status}
				lastActivity={view.lastActivity}
				author={view.author}
				name={barName(card)}
				now={props.now}
				class="butler-face"
				style={{ width: `${cardSize.w}px`, height: `${cardSize.h}px` }}
				dataNode={`session:${session.id}`}
				frame={
					<>
						<CardBody
							view={view}
							after={<ButlerChips card={card} />}
							subagents={
								<SubagentChipList
									shown={chips.shown}
									more={chips.more}
									now={props.now}
								/>
							}
						/>
						<ButlerCardFootView card={card} linked={linked} now={props.now} />
					</>
				}
			/>
		</div>
	);
}

/** The statuses the board shows as the card's edge rather than a ribbon. */
const ribbonless = new Set<CardStatus>(["working", "watching", "stopped"]);

/** One card on one line: its status, title, who started it and its status pill. */
function Strip(props: { card: SheetCard; now: number }): JSX.Element {
	const { card, view } = props.card;
	const pill = {
		status: view.status,
		lastActivity: view.lastActivity,
		now: props.now,
	};
	return (
		<div
			class={`sheet-strip node session card-face act-${view.status} author-${view.author.kind}`}
		>
			<div class="frame sheet-strip-frame">
				<StatusIcon status={view.status} size={18} />
				<span class="sheet-strip-text">
					<span class="sheet-strip-kind">{barName(card)}</span>
					<span class="sheet-strip-title">{card.title}</span>
				</span>
				<AuthorChip author={view.author} />
				{ribbonless.has(view.status) ? (
					<StatusBadge {...pill} />
				) : (
					<StatusRibbon {...pill} />
				)}
			</div>
			{view.status === "working" && <BusyEdge />}
		</div>
	);
}

function Dashboard(props: { input: SheetInput }): JSX.Element | null {
	const { dashboard, now } = props.input;
	if (!dashboard) return null;
	const { project, dash } = dashboard;
	const current = { at: now, stale: false };
	return (
		<article class="dash sheet-dash" aria-label={`${project.title} dashboard`}>
			<header class="dash-head">
				<div class="dash-title-block">
					<h3 class="dash-title">{project.title}</h3>
					<p class="dash-meta">
						{stageNames[project.stage]}
						{project.area && ` · ${project.area}`}
						{project.stageSince !== null &&
							` · since ${dateOf(project.stageSince)}`}
						{project.stale && " · stale"}
					</p>
				</div>
				<LifecycleStrip project={project} />
			</header>
			<DashboardBody
				dash={dash}
				project={project}
				t={now}
				projectsAsOf={current}
				boardAsOf={current}
				open={{ target: () => {}, project: () => {} }}
			/>
		</article>
	);
}

export function Sheet(props: { input: SheetInput }): JSX.Element | null {
	const { input } = props;
	switch (input.kind) {
		case "cards":
			return (
				<div class="sheet-cards">
					{input.cards.map((card) => (
						<Card key={card.card.id} card={card} now={input.now} />
					))}
				</div>
			);
		case "strip": {
			const first = input.cards[0];
			return first ? <Strip card={first} now={input.now} /> : null;
		}
		case "dashboard":
			return <Dashboard input={input} />;
		case "report":
			return input.report ? (
				<div class="sheet-report">
					<ReportDashboard report={input.report} />
				</div>
			) : null;
	}
}
