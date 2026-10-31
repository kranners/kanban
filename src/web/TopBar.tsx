import {
	Bed,
	Broom,
	LoaderCircle,
	Megaphone,
	Moon,
	Plus,
	RotateCw,
	ShieldCheck,
	Sun,
	SunMoon,
} from "lucide-preact";
import { useState } from "preact/hooks";
import type { AgentButton } from "../shared/types.ts";
import { NotifyToggle } from "./Alerts.tsx";
import { AnnounceDialog } from "./Announce.tsx";
import { closeButtonPanel } from "./Comments.tsx";
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
import { PermissionSurveyDialog } from "./PermissionSurvey.tsx";
import { connection, newSessionOpen } from "./state.ts";
import { cycleTheme, theme } from "./theme.ts";

const themeIcon = { system: SunMoon, light: Sun, dark: Moon };
const themeName = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
};

const awayMessage =
	"I'm stepping away for an extended period and won't be around to answer. Ask me now, in one message, for everything you will need to carry on unattended until your task is done: permissions, credentials, decisions and approvals. Once I've answered, keep working without me.";

const agentButtonCopy = {
	tidy: {
		icon: Broom,
		label: "Tidy the board",
		busy: "Tidying the board",
		prompt:
			"Tidy up the board: group the sessions into project regions by directory, lay out each region's cards in a neat grid, and keep notes and stickers beside what they are about.",
		ask: "Tidy the board?",
		confirmLabel: "Tidy",
		detail:
			"The board agent groups sessions into project regions by directory and lays out their cards, notes and stickers.",
		note: null,
	},
	snooze: {
		icon: Bed,
		label: "Leave for a while",
		busy: "Telling sessions you're leaving",
		prompt: `The user is leaving for an extended period. Start with board_snapshot, then call send_prompt on every session whose activity is working, watching or idle, with exactly this text: "${awayMessage}" Skip every session whose activity is needs-you: it is waiting on a question or permission prompt, so send it nothing and never answer its prompt with answer_prompt. Skip sessions that are done, failed or stopped. If send_prompt refuses a session, do not retry or work around it. Do not move, note or change anything on the board. Finish with a short summary: the sessions you told, then each session you skipped because it was waiting on the user (by name, with what it is waiting on), then each session send_prompt refused (by name, with the reason).`,
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
	const { label } = copy;
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

function PermissionSurveyButton() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				class="icon-button"
				aria-haspopup="dialog"
				aria-label="Gather permissions"
				title="Gather permissions every running session expects to need"
				onClick={() => setOpen(true)}
			>
				<ShieldCheck size={16} />
			</button>
			{open && <PermissionSurveyDialog onClose={() => setOpen(false)} />}
		</>
	);
}

function AnnounceButton() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				class="icon-button"
				aria-haspopup="dialog"
				aria-label="Announce to every session"
				title="Announce to every session, sent right away even to working ones"
				onClick={() => setOpen(true)}
			>
				<Megaphone size={16} />
			</button>
			{open && <AnnounceDialog onClose={() => setOpen(false)} />}
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
				<AnnounceButton />
				<PermissionSurveyButton />
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
