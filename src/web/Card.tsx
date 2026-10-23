import { Bot, Server, Terminal } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { Preview, Session, Subagent } from "../shared/types.ts";
import { ActivityBadge, activityLabel } from "./activity.tsx";
import type { PlacedNode } from "./layout.ts";
import { relativeTime } from "./time.ts";

type Emphasis = { dimmed: boolean; lit: boolean; grouped?: boolean };

function nodeClass(base: string, emphasis: Emphasis): string {
	return [
		base,
		emphasis.dimmed && "dimmed",
		emphasis.lit && "lit",
		emphasis.grouped && "grouped",
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

function ReadOnlyChip() {
	return (
		<span class="chip">
			<Terminal size={12} aria-hidden="true" />
			In a terminal · read-only
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
					<ReadOnlyChip />
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
			<ReadOnlyChip />
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

function cardStatus(session: Session): string {
	const detail =
		session.activity === "needs-you" ? session.needs : session.doing;
	const label = activityLabel[session.activity];
	return detail ? `${label}: ${detail}` : label;
}

export function SessionCard(props: {
	node: PlacedNode;
	session: Session;
	preview: Preview | undefined;
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
				aria-label={`Open ${session.name}, ${cardStatus(session)}`}
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
				`node subagent${subagent.live ? " live" : ""}`,
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
				<div class="sub-type">
					{subagent.type}
					{subagent.live && (
						<span class="pulse sub-pulse" role="img" aria-label="running" />
					)}
				</div>
				<div class="sub-desc">{subagent.description}</div>
			</div>
			<time class="sub-time num">
				{relativeTime(subagent.updatedAt, props.now)}
			</time>
		</div>
	);
}
