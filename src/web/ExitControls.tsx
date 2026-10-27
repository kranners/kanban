import "./actions.css";
import { CircleAlert, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import type { Session } from "../shared/types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { ExitState } from "./exitState.ts";
import { askToExit, dismissExit, exitAsk, exitSession, held } from "./exits.ts";
import { optionKey } from "./focus/platform.ts";

export function exitStateClass(state: ExitState | undefined): string {
	return state ? `exit-${state.phase}` : "";
}

function title(force: boolean, skipAsking: boolean): string {
	if (force && skipAsking) return "Force exit now";
	if (force) return "Force exit";
	if (skipAsking) return "Exit session now";
	return `Exit session (hold Shift to force, ${optionKey} to skip confirming)`;
}

export function CloseButton(props: {
	session: Session;
	state: ExitState | undefined;
}): JSX.Element {
	const checking = props.state?.phase === "checking";
	const { shift: force, option: skipAsking } = held.value;
	const label = force
		? `Force exit ${props.session.name}`
		: `Exit ${props.session.name}`;
	const exit = (event: MouseEvent) => {
		const now = held.peek();
		const forced = event.shiftKey || now.shift;
		if (event.altKey || now.option) void exitSession(props.session, forced);
		else askToExit(props.session, forced);
	};
	return (
		<button
			type="button"
			class={`close-bubble${force ? " force" : ""}`}
			aria-label={checking ? `Exiting ${props.session.name}` : label}
			title={title(force, skipAsking)}
			disabled={checking}
			data-no-pan
			onClick={exit}
		>
			{checking ? (
				<LoaderCircle size={13} class="focus-spin" aria-hidden="true" />
			) : (
				<X size={13} strokeWidth={2.5} aria-hidden="true" />
			)}
		</button>
	);
}

export function ExitNotice(props: {
	session: Session;
	state: ExitState | undefined;
}): JSX.Element | null {
	const { state } = props;
	if (state?.phase === "checking")
		return (
			<div class="exit-notice checking" role="status" data-no-pan>
				<LoaderCircle size={14} class="focus-spin" aria-hidden="true" />
				<p>
					{state.force
						? "Exiting…"
						: "Asking the agent whether it's safe to exit…"}
				</p>
			</div>
		);
	if (state?.phase !== "refused") return null;
	return (
		<div class="exit-notice refused" role="alert" data-no-pan>
			<CircleAlert size={14} class="exit-notice-alert" aria-hidden="true" />
			<div class="exit-notice-text">
				<strong>{state.title}</strong>
				<p>{state.message}</p>
			</div>
			<button
				type="button"
				class="exit-notice-dismiss"
				onClick={() => dismissExit(props.session.id)}
				aria-label="Dismiss"
			>
				<X size={13} aria-hidden="true" />
			</button>
		</div>
	);
}

function consequence(session: Session): string {
	return session.kind === "background"
		? "Exiting stops it, then removes it with claude rm, which keeps unpushed work and says so if it refuses."
		: "Exiting sends SIGTERM to the terminal process it runs in.";
}

export function ExitDialog(): JSX.Element | null {
	const ask = exitAsk.value;
	if (!ask) return null;
	const { session, force } = ask;
	const close = () => {
		exitAsk.value = null;
	};
	return (
		<ConfirmDialog
			title={force ? `Force exit ${session.name}?` : `Exit ${session.name}?`}
			confirmLabel={force ? "Force exit" : "Exit session"}
			danger={force}
			onCancel={close}
			onConfirm={() => {
				close();
				void exitSession(session, force);
			}}
		>
			<p>
				{force
					? "This ends the session now, without asking whether it has unfinished work."
					: "The board first asks the agent whether it has outstanding work, and only exits it if the agent says it's safe."}
			</p>
			<p class="focus-muted">{consequence(session)}</p>
		</ConfirmDialog>
	);
}
