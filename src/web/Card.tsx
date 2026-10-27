import { Bot, Server, Terminal } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { RegionColour } from "../shared/colours.ts";
import type { Preview, Session, Subagent } from "../shared/types.ts";
import "./attention.css";
import {
	outstandingSubagents,
	type SubagentCounts,
	subagentState,
} from "../shared/subagents.ts";
import { ActivityBadge, ActivityIcon, activityLabel } from "./activity.tsx";
import type { PlacedNode } from "./layout.ts";
import { subagentHeadline } from "./subagentCounts.ts";
import { ago, relativeTime } from "./time.ts";

type Emphasis = {
	dimmed: boolean;
	lit: boolean;
	region?: RegionColour;
	arrived?: boolean;
	beckoned?: boolean;
};

function nodeClass(base: string, emphasis: Emphasis): string {
	return [
		base,
		emphasis.dimmed && "dimmed",
		emphasis.lit && "lit",
		emphasis.arrived && "arrived",
		emphasis.beckoned && "beckoned",
		emphasis.region && `grouped region region-${emphasis.region}`,
	]
		.filter(Boolean)
		.join(" ");
}

function position(node: PlacedNode) {
	return {
		transform: `translate(${node.x}px, ${node.y}px)`,
		width: `${node.w}px`,
		height: `${node.h}px`,
	};
}

function TerminalPreview(props: { html: string }) {
	const content = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (content.current) content.current.innerHTML = props.html;
	}, [props.html]);
	return (
		<div class="term" aria-hidden="true">
			<div class="term-content" ref={content} />
		</div>
	);
}

function TerminalChip(props: { cmux: boolean }) {
	return (
		<span class="chip">
			<Terminal size={12} aria-hidden="true" />
			{props.cmux ? "In cmux" : "In a terminal · read-only"}
		</span>
	);
}

function InteractiveBody(props: {
	session: Session;
	preview: Preview | undefined;
}) {
	if (props.preview)
		return (
			<>
				<TerminalPreview html={props.preview.html} />
				<div class="chip-overlay">
					<TerminalChip cmux={props.session.cmux} />
				</div>
			</>
		);
	return (
		<div class="term placeholder" aria-hidden="true">
			<div class="term-lines">
				<div class="term-line">
					<span class="term-prompt">❯</span> {props.session.name}
				</div>
				{props.session.doing && (
					<div class="term-line term-dim">
						<span class="term-bullet">●</span> {props.session.doing}
					</div>
				)}
			</div>
			<TerminalChip cmux={props.session.cmux} />
		</div>
	);
}

function BackgroundBody(props: { preview: Preview | undefined }) {
	if (props.preview) return <TerminalPreview html={props.preview.html} />;
	return (
		<div class="term placeholder" aria-hidden="true">
			<div class="term-lines">
				<div class="term-line term-dim">Waiting for output…</div>
			</div>
		</div>
	);
}

function BusyEdge() {
	return <span class="busy-edge" aria-hidden="true" />;
}

function Ribbon(props: { session: Session; now: number }) {
	const { activity } = props.session;
	if (activity === "working" || activity === "stopped") return null;
	return (
		<span class={`ribbon act-${activity}`} aria-hidden="true">
			<ActivityIcon activity={activity} size={13} />
			<span class="ribbon-text">
				{activity === "done"
					? `Finished · ${ago(props.session.updatedAt, props.now)}`
					: activity === "idle"
						? `Idle · ${ago(props.session.updatedAt, props.now)}`
						: activityLabel[activity]}
			</span>
		</span>
	);
}

function SubagentRibbon(props: { counts: SubagentCounts | undefined }) {
	const { counts } = props;
	if (!counts) return null;
	const outstanding = outstandingSubagents(counts);
	if (outstanding === 0) return null;
	return (
		<span
			class={`ribbon subagent-ribbon${counts.working > 0 ? " running" : ""}`}
			aria-hidden="true"
		>
			<Bot size={13} aria-hidden="true" />
			<span class="ribbon-text">{subagentHeadline(counts, "waiting")}</span>
			<span class="ribbon-count num">{outstanding}</span>
		</span>
	);
}

function cardStatus(
	session: Session,
	subagents: SubagentCounts | undefined,
): string {
	const detail =
		session.activity === "needs-you" ? session.needs : session.doing;
	const label = activityLabel[session.activity];
	const status = detail ? `${label}: ${detail}` : label;
	const waiting =
		subagents && outstandingSubagents(subagents) > 0
			? `; subagents ${subagentHeadline(subagents)}`
			: "";
	return `${status}${waiting}`;
}

export function SessionCard(props: {
	node: PlacedNode;
	session: Session;
	preview: Preview | undefined;
	subagents?: SubagentCounts;
	now: number;
	emphasis: Emphasis;
	onOpen: (id: string, origin: DOMRect) => void;
	corner?: ComponentChildren;
	notice?: ComponentChildren;
	state?: string;
}) {
	const { session } = props;
	const KindIcon = session.kind === "interactive" ? Terminal : Server;
	const open = (event: MouseEvent) =>
		props.onOpen(
			session.id,
			(event.currentTarget as HTMLElement).getBoundingClientRect(),
		);
	return (
		<div
			class={nodeClass(
				`node session act-${session.activity} ${props.state ?? ""}`.trim(),
				props.emphasis,
			)}
			style={position(props.node)}
			data-node={props.node.key}
		>
			<div class="label">
				<div class="label-name">{session.name}</div>
				<div class="label-doing">{session.doing ?? activityHint(session)}</div>
			</div>
			<button
				type="button"
				class="frame"
				aria-label={`Open ${session.name}, ${cardStatus(session, props.subagents)}`}
				onClick={open}
			>
				<div class="body">
					{session.kind === "interactive" ? (
						<InteractiveBody session={session} preview={props.preview} />
					) : (
						<BackgroundBody preview={props.preview} />
					)}
					{session.activity === "needs-you" && session.needs && (
						<div class="needs" title={session.needs}>
							{session.needs}
						</div>
					)}
				</div>
				<div class="foot">
					<ActivityBadge activity={session.activity} />
					<span class="foot-project" title={session.cwd}>
						{session.project}
					</span>
					<span class="foot-end">
						<span
							class="foot-kind"
							title={
								session.kind === "interactive" ? "Interactive" : "Background"
							}
						>
							<KindIcon size={13} aria-hidden="true" />
						</span>
						<time class="num">
							{relativeTime(session.updatedAt, props.now)}
						</time>
					</span>
				</div>
			</button>
			{session.activity === "working" && <BusyEdge />}
			<Ribbon session={session} now={props.now} />
			<SubagentRibbon counts={props.subagents} />
			{props.notice}
			<span class="resize-handle" data-resize aria-hidden="true" />
			{props.corner && <div class="node-corner">{props.corner}</div>}
		</div>
	);
}

function activityHint(session: Session): string {
	switch (session.activity) {
		case "idle":
			return "Waiting for a prompt";
		case "done":
			return "Finished";
		case "failed":
			return "Failed";
		case "stopped":
			return "Stopped";
		case "needs-you":
			return "Needs you";
		case "working":
			return "Working";
	}
}

export function SubagentCard(props: {
	node: PlacedNode;
	subagent: Subagent;
	now: number;
	emphasis: Emphasis;
}) {
	const { subagent } = props;
	return (
		<div
			class={nodeClass(
				`node subagent act-${subagentState(subagent)}${subagent.live ? " live" : ""}`,
				props.emphasis,
			)}
			style={position(props.node)}
			data-node={props.node.key}
			title={subagent.description}
		>
			<span class="sub-icon">
				<Bot size={14} aria-hidden="true" />
			</span>
			<div class="sub-text">
				<div class="sub-title">
					<span class="sub-name">{subagent.description || subagent.type}</span>
					{subagent.live && (
						<span class="pulse sub-pulse" role="img" aria-label="running" />
					)}
				</div>
				<div class="sub-kind">{subagent.type}</div>
			</div>
			<time class="sub-time num">
				{relativeTime(subagent.updatedAt, props.now)}
			</time>
			{subagent.live && <BusyEdge />}
		</div>
	);
}
