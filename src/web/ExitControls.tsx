import "./actions.css";
import { CircleAlert, LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import type { Session } from "../shared/types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { ExitState } from "./exitState.ts";
import {
	askToExit,
	dismissExit,
	exitAsk,
	exitSession,
	exitSessions,
	held,
} from "./exits.ts";
import { optionKey } from "./focus/platform.ts";

export function exitStateClass(state: ExitState | undefined): string {
	return state ? `exit-${state.phase}` : "";
}

export function exitTitle(
	force: boolean,
	skipAsking: boolean,
	what = "session",
): string {
	if (force && skipAsking) return `Force exit ${what} now`;
	if (force) return `Force exit ${what}`;
	if (skipAsking) return `Exit ${what} now`;
	return `Exit ${what} (hold Shift to force, ${optionKey} to skip confirming)`;
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
			title={exitTitle(force, skipAsking)}
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

function consequences(sessions: readonly Session[]): string[] {
	const kinds = new Set(
		sessions.map((session) => (session.cloud ? "cloud" : session.kind)),
	);
	return [
		...(kinds.has("cloud")
			? ["Exiting a cloud session archives it on claude.ai."]
			: []),
		...(kinds.has("background")
			? [
					"Exiting a background session stops it, then removes it with claude rm, which keeps unpushed work and says so if it refuses.",
				]
			: []),
		...(kinds.has("interactive")
			? [
					"Exiting an interactive session sends SIGTERM to the terminal process it runs in.",
				]
			: []),
	];
}

function plural(count: number): string {
	return count === 1 ? "1 session" : `${count} sessions`;
}

function explanation(ask: NonNullable<typeof exitAsk.value>): string {
	if (ask.project === undefined)
		return ask.force
			? "This ends the session now, without asking whether it has unfinished work."
			: "The board first asks the agent whether it has outstanding work, and only exits it if the agent says it's safe.";
	return ask.force
		? `This ends all ${plural(ask.sessions.length)} in ${ask.project} now, without asking whether they have unfinished work.`
		: `The board asks each of the ${plural(ask.sessions.length)} in ${ask.project} whether it has outstanding work, and exits only the ones that say it's safe. The rest stay, with their reason on their card.`;
}

function dialogTitle(ask: NonNullable<typeof exitAsk.value>): string {
	const verb = ask.force ? "Force exit" : "Exit";
	if (ask.project === undefined) return `${verb} ${ask.sessions[0]?.name}?`;
	return `${verb} every session in ${ask.project}?`;
}

export function ExitDialog(): JSX.Element | null {
	const ask = exitAsk.value;
	if (!ask) return null;
	const { sessions, force } = ask;
	const close = () => {
		exitAsk.value = null;
	};
	const label = force ? "Force exit" : "Exit";
	return (
		<ConfirmDialog
			title={dialogTitle(ask)}
			confirmLabel={
				ask.project === undefined
					? `${label} session`
					: `${label} ${plural(sessions.length)}`
			}
			danger={force}
			onCancel={close}
			onConfirm={() => {
				close();
				void exitSessions(sessions, force);
			}}
		>
			<p>{explanation(ask)}</p>
			{consequences(sessions).map((line) => (
				<p key={line} class="focus-muted">
					{line}
				</p>
			))}
		</ConfirmDialog>
	);
}
