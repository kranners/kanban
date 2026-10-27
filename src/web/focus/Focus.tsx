import "./focus.css";
import "./agent.css";
import { Bot, MessagesSquare, SquareTerminal, X } from "lucide-preact";
import type { JSX } from "preact";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "preact/hooks";
import { subagentState } from "../../shared/subagents.ts";
import type { Activity, Session, Subagent } from "../../shared/types.ts";
import { ActivityBadge } from "../activity.tsx";
import { openSubagent, subagentsById } from "../state.ts";
import { AgentView } from "./AgentView.tsx";
import { AttachedTerminal } from "./AttachedTerminal.tsx";
import { MirroredTerminal } from "./MirroredTerminal.tsx";
import { commandKey } from "./platform.ts";

export type FocusTarget =
	| { kind: "session"; session: Session }
	| { kind: "subagent"; subagent: Subagent };

const kindLabels = { background: "Background", interactive: "Terminal" };

const closeShortcut = `${commandKey}.`;

const subagentActivity: Record<ReturnType<typeof subagentState>, Activity> = {
	working: "working",
	idle: "idle",
	done: "done",
};

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

export function Focus(props: {
	target: FocusTarget;
	onClose: () => void;
	origin?: DOMRect;
}): JSX.Element {
	const { target, onClose } = props;
	const backdrop = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const [raw, setRaw] = useState(false);

	useLayoutEffect(() => {
		if (panel.current && props.origin) growFrom(panel.current, props.origin);
	}, []);

	useEffect(() => {
		const opener = document.activeElement;
		const own = backdrop.current;
		const behind = [...(own?.parentElement?.children ?? [])].filter(
			(element): element is HTMLElement =>
				element !== own && element instanceof HTMLElement,
		);
		for (const element of behind) element.inert = true;
		if (target.kind === "subagent") closeButton.current?.focus();
		return () => {
			for (const element of behind) element.inert = false;
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

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

	const subagentLink = useCallback(
		(agentId: string) =>
			subagentsById.value.has(agentId) ? () => openSubagent(agentId) : null,
		[],
	);

	const session = target.kind === "session" ? target.session : null;
	const subagent = target.kind === "subagent" ? target.subagent : null;
	const activity: Activity = session
		? session.activity
		: subagentActivity[subagentState(subagent as Subagent)];
	const name = session?.name ?? subagent?.description ?? subagent?.type ?? "";
	const doing = session
		? (session.needs ?? session.doing)
		: (subagent?.type ?? null);
	const terminal = session && hasTerminal(session);

	return (
		<div
			ref={backdrop}
			class="focus-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={name}
		>
			<button
				type="button"
				class="focus-scrim"
				tabIndex={-1}
				aria-hidden="true"
				onClick={onClose}
			/>
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
									<span class="focus-kind">{kindLabels[session.kind]}</span>
								</>
							) : (
								<span class="focus-kind">
									<Bot size={11} aria-hidden="true" /> Subagent
								</span>
							)}
						</div>
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
							subagent={subagentLink}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
