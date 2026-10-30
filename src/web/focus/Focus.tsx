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
import type { Activity, Session, Subagent } from "../../shared/types.ts";
import { ActivityBadge } from "../activity.tsx";
import { arrangement } from "../arrangement.ts";
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
import { AgentView } from "./AgentView.tsx";
import { AttachedTerminal } from "./AttachedTerminal.tsx";
import { MirroredTerminal } from "./MirroredTerminal.tsx";
import { commandKey } from "./platform.ts";
import type { LinkedSubagent, Links } from "./Transcript.tsx";

export type FocusTarget =
	| { kind: "session"; session: Session }
	| { kind: "subagent"; subagent: Subagent };

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

function attachKey(session: Session): string | null {
	if (session.cloud) return session.id;
	return session.attachable ? session.short : null;
}

function hasTerminal(session: Session): boolean {
	return attachKey(session) !== null || session.cmux;
}

function RawTerminal(props: { session: Session }) {
	const { session } = props;
	const key = attachKey(session);
	return key ? (
		<AttachedTerminal short={key} />
	) : (
		<MirroredTerminal id={session.id} />
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
				: { kind: "subagent", id: target.subagent.id },
		);
		const node = arrangement.peek()?.nodes.get(key);
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
			if ((event.metaKey || event.ctrlKey) && event.key === ".") {
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

	const session = target.kind === "session" ? target.session : null;
	const subagent = target.kind === "subagent" ? target.subagent : null;
	const activity: Activity = session
		? session.activity
		: subagentState(subagent as Subagent);
	const name = session?.name ?? subagent?.description ?? subagent?.type ?? "";
	const said = session ? (session.needs ?? session.doing) : null;
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
				{session && raw ? (
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
