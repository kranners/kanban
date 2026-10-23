import "./focus.css";
import { X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { Session } from "../../shared/types.ts";
import { ActivityBadge } from "../activity.tsx";
import { AttachedTerminal } from "./AttachedTerminal.tsx";
import { commandKey } from "./platform.ts";
import { TranscriptView } from "./TranscriptView.tsx";

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

export function Focus(props: {
	session: Session;
	onClose: () => void;
	origin?: DOMRect;
}): JSX.Element {
	const { session, onClose } = props;
	const backdrop = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const close = useRef(onClose);
	close.current = onClose;

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
		closeButton.current?.focus();
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

	const doing = session.needs ?? session.doing;

	return (
		<div
			ref={backdrop}
			class="focus-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={session.name}
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
					<ActivityBadge activity={session.activity} />
					<div class="focus-titles">
						<div class="focus-title-row">
							<h2 class="focus-name">{session.name}</h2>
							{doing && <span class="focus-doing">{doing}</span>}
						</div>
						<div class="focus-meta">
							<span
								class="focus-cwd"
								title={`${session.project} · ${session.cwd}`}
							>
								<bdi>{session.cwd}</bdi>
							</span>
							<span class="focus-kind">{kindLabels[session.kind]}</span>
						</div>
					</div>
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
					{session.attachable && session.short ? (
						<AttachedTerminal short={session.short} />
					) : (
						<TranscriptView id={session.id} />
					)}
				</div>
			</div>
		</div>
	);
}
