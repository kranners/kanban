import {
	Bed,
	Broom,
	LoaderCircle,
	Moon,
	Plus,
	RotateCw,
	Sun,
	SunMoon,
} from "lucide-preact";
import { useState } from "preact/hooks";
import type { AgentButton } from "../shared/types.ts";
import { NotifyToggle } from "./Alerts.tsx";
import {
	agentButtonLabels,
	closeButtonPanel,
	snoozePrompt,
	tidyPrompt,
} from "./Comments.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import {
	buttonThreads,
	openButton,
	pinState,
	startThread,
} from "./comments.ts";
import { held } from "./exits.ts";
import { optionKey } from "./focus/platform.ts";
import { Mark } from "./Mark.tsx";
import { NextNeedingYou } from "./NeedsYou.tsx";
import { connection, newSessionOpen } from "./state.ts";
import { cycleTheme, theme } from "./theme.ts";

const themeIcon = { system: SunMoon, light: Sun, dark: Moon };
const themeName = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
};

const agentButtonCopy = {
	tidy: {
		icon: Broom,
		busy: "Tidying the board",
		prompt: tidyPrompt,
		ask: "Tidy the board?",
		confirmLabel: "Tidy",
		detail:
			"The board agent groups sessions into project regions by directory and lays out their cards, notes and stickers.",
		note: null,
	},
	snooze: {
		icon: Bed,
		busy: "Telling sessions you're leaving",
		prompt: snoozePrompt,
		ask: "Leave for a while?",
		confirmLabel: "Tell sessions",
		detail:
			"The board agent tells every running session you're leaving for an extended period, so each asks you now for every permission, credential, decision and approval it needs to carry on unattended.",
		note: "Sessions waiting on a question or permission prompt are skipped and listed in its summary.",
	},
} satisfies Record<AgentButton, unknown>;

function BoardAgentButton(props: { button: AgentButton }) {
	const { button } = props;
	const copy = agentButtonCopy[button];
	const label = agentButtonLabels[button];
	const thread = buttonThreads.value.get(button);
	const state = thread ? pinState(thread) : null;
	const unseen = state === "answered" || state === "failed";
	const open = openButton.value === button;
	const [asking, setAsking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const Icon = copy.icon;
	const run = async () => {
		const started = await startThread({ x: 0, y: 0 }, copy.prompt, button);
		setError(started.ok ? null : started.error);
	};
	const title =
		error ??
		(state === "running"
			? `${copy.busy} · click to watch`
			: unseen
				? `${label} · click to see the result`
				: `${label} with the board agent (hold ${optionKey} to skip confirming)`);
	return (
		<>
			<button
				type="button"
				class="icon-button agent-button"
				data-agent-button={button}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={state === "running" ? copy.busy : label}
				title={title}
				onClick={(event) => {
					if (state === "running") {
						openButton.value = open ? null : button;
						return;
					}
					if (event.altKey || held.peek().option) {
						void run();
						return;
					}
					if (open) {
						closeButtonPanel();
						return;
					}
					if (unseen) {
						openButton.value = button;
						return;
					}
					setAsking(true);
				}}
			>
				{state === "running" ? (
					<LoaderCircle size={16} class="spin" />
				) : (
					<Icon size={16} />
				)}
				{(unseen || error) && (
					<span class={`agent-dot dot-${error ? "failed" : state}`} />
				)}
			</button>
			{asking && (
				<ConfirmDialog
					title={copy.ask}
					confirmLabel={copy.confirmLabel}
					onCancel={() => setAsking(false)}
					onConfirm={() => {
						setAsking(false);
						void run();
					}}
				>
					<p>{copy.detail}</p>
					{copy.note && <p class="focus-muted">{copy.note}</p>}
				</ConfirmDialog>
			)}
		</>
	);
}

export function TopBar() {
	const ThemeIcon = themeIcon[theme.value];
	return (
		<header class="topbar">
			<div class="brand">
				<Mark />
				<span class="wordmark">kanban</span>
				<span class="host">{location.hostname || "local"}</span>
				{connection.value === "reconnecting" && (
					<span class="reconnecting" role="status">
						<span class="pulse" />
						Reconnecting
					</span>
				)}
				{connection.value === "lost" && (
					<button
						type="button"
						class="reconnecting"
						onClick={() => location.reload()}
						title="The board lost its connection; reload to sign in again"
					>
						<RotateCw size={12} />
						Reload
					</button>
				)}
			</div>
			<div class="actions">
				<NextNeedingYou />
				<BoardAgentButton button="tidy" />
				<BoardAgentButton button="snooze" />
				<NotifyToggle />
				<button
					type="button"
					class="icon-button"
					onClick={cycleTheme}
					aria-label={themeName[theme.value]}
					title={themeName[theme.value]}
				>
					<ThemeIcon size={16} />
				</button>
				<button
					type="button"
					class="primary"
					onClick={() => {
						newSessionOpen.value = true;
					}}
				>
					<Plus size={16} strokeWidth={2.25} />
					<span class="primary-label">New session</span>
				</button>
			</div>
		</header>
	);
}
