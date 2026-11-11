import "./focus.css";
import "./agent.css";
import {
	Bot,
	ExternalLink,
	MessagesSquare,
	SquareTerminal,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "preact/hooks";
import { subagentState } from "../../shared/subagents.ts";
import type {
	Activity,
	ButlerCard,
	Session,
	Step,
	Subagent,
} from "../../shared/types.ts";
import { ActivityBadge } from "../activity.tsx";
import { arrangement } from "../arrangement.ts";
import { ButlerMark } from "../Butler.tsx";
import { ButlerChips, ButlerSummary, kindOf } from "../ButlerCardParts.tsx";
import { threadKindLabels } from "../butlerThreads.ts";
import { keepInView } from "../Canvas.tsx";
import { ArtifactLink } from "../Card.tsx";
import { nodeKey } from "../layout.ts";
import { plainText } from "../markdown.ts";
import {
	board,
	focusedSessionId,
	focusedSubagentId,
	openSubagent,
	subagentsById,
} from "../state.ts";
import { ThreadBody, useThreadView } from "../ThreadCardPanel.tsx";
import { AgentView } from "./AgentView.tsx";
import { AttachedTerminal } from "./AttachedTerminal.tsx";
import { MirroredTerminal } from "./MirroredTerminal.tsx";
import { commandKey } from "./platform.ts";
import type { LinkedSubagent, Links } from "./Transcript.tsx";

export type FocusTarget =
	| { kind: "session"; session: Session }
	| { kind: "subagent"; subagent: Subagent }
	| { kind: "thread"; thread: string; card: ButlerCard | null };

const kindLabels = { background: "Background", interactive: "Terminal" };

const closeShortcut = `${commandKey}.`;

function growFrom(panel: HTMLElement, origin: DOMRect): void {
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const target = panel.getBoundingClientRect();
	const dx = origin.left - target.left;
	const dy = origin.top - target.top;
	const sx = origin.width / target.width;
	const sy = origin.height / target.height;
	panel.animate(
		[
			{
				transformOrigin: "0 0",
				transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
				opacity: 0.4,
			},
			{ transformOrigin: "0 0", transform: "none", opacity: 1 },
		],
		{ duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" },
	);
}

function outside(own: HTMLElement | null): HTMLElement[] {
	const app = own?.closest(".app");
	const behind: HTMLElement[] = [];
	for (let node = own; node && node !== app; node = node.parentElement) {
		for (const sibling of node.parentElement?.children ?? []) {
			if (sibling !== node && sibling instanceof HTMLElement) {
				behind.push(sibling);
			}
		}
	}
	return behind;
}

function hasTerminal(session: Session): boolean {
	return (session.attachable && session.short !== null) || session.cmux;
}

function RawTerminal(props: { session: Session }) {
	const { session } = props;
	return session.attachable && session.short ? (
		<AttachedTerminal short={session.short} />
	) : (
		<MirroredTerminal id={session.id} />
	);
}

/** A card of Butler's with no thread of its own, such as a change: its summary, chips and timeline. */
function ButlerCardDetail(props: { card: ButlerCard; steps: readonly Step[] }) {
	return (
		<div class="butler-card-detail">
			<ButlerChips card={props.card} />
			<ButlerSummary card={props.card} />
			<section class="detail-section" aria-label="Timeline">
				<div class="detail-head">
					<span>Timeline</span>
				</div>
				<ul class="butler-card-steps">
					{[...props.steps].reverse().map((step) => (
						<li key={`${step.at}-${step.text}`}>
							<time class="num">{new Date(step.at).toLocaleString()}</time>
							<span>{step.text}</span>
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}

export function Focus(props: {
	target: FocusTarget;
	onClose: () => void;
	origin?: DOMRect;
	docked: boolean;
}): JSX.Element {
	const { target, onClose, docked } = props;
	const backdrop = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const [raw, setRaw] = useState(false);

	useLayoutEffect(() => {
		if (panel.current && props.origin) growFrom(panel.current, props.origin);
	}, []);

	useLayoutEffect(() => {
		if (!docked) return;
		const key = nodeKey(
			target.kind === "session"
				? { kind: "session", id: target.session.id }
				: target.kind === "thread"
					? { kind: "session", id: target.card?.id ?? "" }
					: { kind: "subagent", id: target.subagent.id },
		);
		const placed = arrangement.peek();
		const node = placed?.nodes.get(key);
		if (node) keepInView(node);
	}, [docked]);

	useEffect(() => {
		const opener = document.activeElement;
		return () => {
			const switching =
				focusedSessionId.peek() !== null || focusedSubagentId.peek() !== null;
			if (switching) return;
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

	useEffect(() => {
		if (docked) return;
		const behind = outside(backdrop.current);
		for (const element of behind) element.inert = true;
		if (target.kind === "subagent") closeButton.current?.focus();
		return () => {
			for (const element of behind) element.inert = false;
		};
	}, [docked]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const typing =
				event.target instanceof HTMLElement &&
				event.target.closest("input, textarea, [contenteditable]") !== null;
			const escapesThread =
				target.kind === "thread" && event.key === "Escape" && !typing;
			if (
				((event.metaKey || event.ctrlKey) && event.key === ".") ||
				escapesThread
			) {
				event.preventDefault();
				event.stopPropagation();
				close.current();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);

	const links = useMemo((): Links => {
		const subagent = (agentId: string): LinkedSubagent | null => {
			const card = subagentsById.value.get(agentId);
			if (card) {
				return {
					id: agentId,
					label: card.description || card.type,
					open: () => openSubagent(agentId),
					state: subagentState(card),
				};
			}
			const state = board.value?.subagentStates[agentId];
			return state ? { id: agentId, label: agentId, open: null, state } : null;
		};
		return {
			subagent,
			run: (runId) =>
				(board.value?.workflowRuns[runId] ?? []).flatMap((agentId) => {
					const linked = subagent(agentId);
					return linked ? [linked] : [];
				}),
		};
	}, []);

	const card =
		target.kind === "session" &&
		target.session.butler?.card.id === target.session.id
			? target.session.butler.card
			: null;
	const session = target.kind === "session" && !card ? target.session : null;
	const subagent = target.kind === "subagent" ? target.subagent : null;
	const thread =
		target.kind === "thread"
			? target
			: card?.thread
				? { thread: card.thread.id, card }
				: null;
	const threadView = useThreadView(thread?.thread ?? null);
	const read = threadView.view?.card;
	const threadCard = thread
		? {
				title: thread.card?.title ?? read?.title,
				state: thread.card?.state ?? read?.state,
				status: thread.card?.status ?? read?.status,
				kind: thread.card?.thread?.kind ?? read?.thread.kind,
				link: thread.card?.thread?.link ?? read?.link,
			}
		: card
			? {
					title: card.title,
					state: card.state,
					status: card.status,
					kind: undefined,
					link: card.link,
				}
			: null;
	const activity: Activity = session
		? session.activity
		: threadCard
			? (threadCard.state ?? "idle")
			: subagentState(subagent as Subagent);
	const name =
		session?.name ??
		threadCard?.title ??
		subagent?.description ??
		subagent?.type ??
		(thread ? "Butler thread" : "");
	const said = session
		? (session.needs ?? session.doing)
		: (threadCard?.status ?? null);
	const doing = said ? plainText(said) : (subagent?.type ?? null);
	const terminal = session && hasTerminal(session);

	const contents = (
		<div class="focus-panel" ref={panel}>
			<header class="focus-header">
				<ActivityBadge activity={activity} />
				<div class="focus-titles">
					<div class="focus-title-row">
						<h2 class="focus-name">{name}</h2>
						{doing && <span class="focus-doing">{doing}</span>}
					</div>
					<div class="focus-meta">
						{session ? (
							<>
								<span
									class="focus-cwd"
									title={`${session.project} · ${session.cwd}`}
								>
									<bdi>{session.cwd}</bdi>
								</span>
								<span class="focus-kind">
									{session.cloud ? "Cloud" : kindLabels[session.kind]}
								</span>
							</>
						) : threadCard ? (
							<span class="focus-kind">
								<ButlerMark size={11} />{" "}
								{threadCard.kind
									? threadKindLabels[threadCard.kind]
									: card
										? kindOf(card)
										: "Butler"}
							</span>
						) : (
							<span class="focus-kind">
								<Bot size={11} aria-hidden="true" /> Subagent
							</span>
						)}
					</div>
					{session && session.artifacts.length > 0 && (
						<div class="focus-artifacts">
							{session.artifacts.map((artifact) => (
								<ArtifactLink key={artifact.url} artifact={artifact} />
							))}
						</div>
					)}
				</div>
				{terminal && (
					<div class="av-toggle">
						<button
							type="button"
							class="focus-button"
							aria-pressed={!raw}
							onClick={() => setRaw(false)}
							title="Conversation"
						>
							<MessagesSquare size={15} aria-hidden="true" />
							<span class="av-toggle-label">Conversation</span>
						</button>
						<button
							type="button"
							class="focus-button"
							aria-pressed={raw}
							onClick={() => setRaw(true)}
							title="The session's own terminal"
						>
							<SquareTerminal size={15} aria-hidden="true" />
							<span class="av-toggle-label">Terminal</span>
						</button>
					</div>
				)}
				{threadCard?.link && (
					<a
						class="focus-button focus-cloud-link"
						href={threadCard.link}
						target="_blank"
						rel="noreferrer"
						title={thread ? "Open in Discord" : "Open session"}
					>
						<ExternalLink size={15} aria-hidden="true" />
						<span class="av-toggle-label">
							{thread ? "Open in Discord" : "Open session"}
						</span>
					</a>
				)}
				{session?.cloud && (
					<a
						class="focus-button focus-cloud-link"
						href={session.cloud.url}
						target="_blank"
						rel="noreferrer"
						title="Open on claude.ai"
					>
						<ExternalLink size={15} aria-hidden="true" />
						<span class="av-toggle-label">Open on claude.ai</span>
					</a>
				)}
				<button
					ref={closeButton}
					type="button"
					class="focus-button focus-close"
					onClick={onClose}
					title={`Close (${closeShortcut})`}
					aria-label="Close"
				>
					<X size={16} />
					<kbd>{closeShortcut}</kbd>
				</button>
			</header>
			<div class="focus-body">
				{thread ? (
					<ThreadBody {...threadView} />
				) : card ? (
					<ButlerCardDetail
						card={card}
						steps={target.kind === "session" ? target.session.steps : []}
					/>
				) : session && raw ? (
					<RawTerminal session={session} />
				) : (
					<AgentView
						node={
							session
								? { kind: "session", id: session.id }
								: { kind: "subagent", id: subagent?.id ?? "" }
						}
						session={session}
						activity={activity}
						onTerminal={terminal ? () => setRaw(true) : null}
						links={links}
					/>
				)}
			</div>
		</div>
	);

	return (
		<div
			ref={backdrop}
			class={docked ? "focus focus-docked" : "focus focus-backdrop"}
			role="dialog"
			aria-modal={!docked}
			aria-label={name}
			tabIndex={docked ? -1 : undefined}
		>
			<button
				type="button"
				class="focus-scrim"
				tabIndex={-1}
				aria-hidden="true"
				onClick={onClose}
			/>
			{contents}
		</div>
	);
}
