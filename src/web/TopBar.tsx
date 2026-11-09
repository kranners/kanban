import { signal } from "@preact/signals";
import {
	Bed,
	Briefcase,
	Broom,
	CalendarClock,
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
import { NotifyToggle } from "./Alerts.tsx";
import { AnnounceDialog } from "./Announce.tsx";
import { WaitingApprovalsButton } from "./Approvals.tsx";
import { BoardSettingsButton } from "./BoardSettings.tsx";
import { jobComposerOpen } from "./butlerThreads.ts";
import { centreTarget, visibleBoard } from "./Comments.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import {
	composer,
	openThreadId,
	pinState,
	startThread,
	threads,
} from "./comments.ts";
import { held } from "./exits.ts";
import { optionKey } from "./focus/platform.ts";
import { Mark } from "./Mark.tsx";
import { NextNeedingYou } from "./NeedsYou.tsx";
import { NotificationsMenu } from "./Notifications.tsx";
import { PermissionSurveyDialog } from "./PermissionSurvey.tsx";
import { ProjectsButton } from "./Projects.tsx";
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

// The top bar's requests to Butler, who carries them out with his kanban
// tools on spike. Each is an ordinary message, as if typed with /, so it
// lands in a thread on the board and in Discord, and anything acting
// through a session still waits for Aaron's approval there.
const butlerRequests = {
	snooze: {
		icon: Bed,
		label: "Leave for a while",
		busy: "Butler is telling sessions you're leaving",
		prompt: `I'm leaving for an extended period. On my board, send_prompt every session whose activity is working, watching or idle with exactly this text: "${awayMessage}" Skip every session that is waiting on me (needs-you), and never answer its prompt. Skip sessions that are done, failed or stopped. Don't retry or work around a session that refuses. Don't move, note or change anything else on the board. Then tell me which sessions you told, which you skipped because they were waiting on me (with what each is waiting on), and which refused.`,
		ask: "Leave for a while?",
		confirmLabel: "Ask Butler",
		detail:
			"Butler tells every running session you're leaving for an extended period, so each asks you now for every permission, credential, decision and approval it needs to carry on unattended.",
		note: "Each message to a session waits for your approval in Discord, gathered into one DM with Allow all. Sessions waiting on a question are skipped.",
	},
} as const;

type ButlerRequest = keyof typeof butlerRequests;

/** The thread each top bar request last started, while this page is open. */
const requestThreads = signal<Partial<Record<ButlerRequest, string>>>({});

async function askButler(request: ButlerRequest): Promise<string | null> {
	const at = centreTarget()?.board ?? { x: 0, y: 0 };
	const started = await startThread(
		at,
		butlerRequests[request].prompt,
		visibleBoard(),
	);
	if (!started.ok) return started.error;
	requestThreads.value = {
		...requestThreads.peek(),
		[request]: started.value.id,
	};
	return null;
}

function ButlerRequestButton(props: { request: ButlerRequest }) {
	const { request } = props;
	const copy = butlerRequests[request];
	const { label } = copy;
	const threadId = requestThreads.value[request];
	const thread = threadId ? threads.value.get(threadId) : undefined;
	const state = thread ? pinState(thread) : null;
	const busy = state === "running" || state === "queued";
	const [asking, setAsking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const Icon = copy.icon;
	const run = async () => setError(await askButler(request));
	const title =
		error ??
		(busy
			? `${copy.busy} · click to watch`
			: `${label} with Butler (hold ${optionKey} to skip confirming)`);
	return (
		<>
			<button
				type="button"
				class="icon-button agent-button"
				data-agent-button={request}
				aria-haspopup="dialog"
				aria-label={busy ? copy.busy : label}
				title={title}
				onClick={(event) => {
					if (busy && threadId) {
						openThreadId.value = threadId;
						return;
					}
					if (event.altKey || held.peek().option) {
						void run();
						return;
					}
					setAsking(true);
				}}
			>
				{busy ? <LoaderCircle size={16} class="spin" /> : <Icon size={16} />}
				{error && <span class="agent-dot dot-failed" />}
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

export const dailyReportRequest =
	"Every day at 08:00, send me a report on my kanban board: for each session active since the last report, what needs me, what failed, what is still running and what landed, blockers first, a line or two each.";

/** Opens the / popup with a daily report request for Aaron to adjust and send. */
export function openReportRequest(at?: {
	board: { x: number; y: number };
	client: { x: number; y: number };
}): void {
	const target = at ?? centreTarget();
	if (!target) return;
	openThreadId.value = null;
	composer.value = { ...target, text: dailyReportRequest };
}

/**
 * The board's own Tidy: finished cards go to the Archive and everything
 * else is laid out in its region, at once and undoably, with nothing
 * asked of Butler. Cards Aaron pinned stay where they are.
 */
function TidyButton() {
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const run = async () => {
		setBusy(true);
		const response = await fetch("/api/tidy", { method: "POST" }).catch(
			() => null,
		);
		const body = (await response?.json().catch(() => null)) as {
			ok?: boolean;
			text?: string;
			error?: string;
		} | null;
		setBusy(false);
		setSaid(
			body?.ok
				? (body.text ?? "Tidied the board")
				: (body?.error ?? "Could not tidy the board"),
		);
	};
	return (
		<button
			type="button"
			class="icon-button"
			data-agent-button="tidy"
			aria-label="Tidy the board"
			title={`Tidy the board: archive finished cards and lay out the rest; pinned cards stay put${said ? `\n${said}` : ""}`}
			onClick={() => void run()}
		>
			{busy ? <LoaderCircle size={16} class="spin" /> : <Broom size={16} />}
		</button>
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

function NewJobButton() {
	return (
		<button
			type="button"
			class="icon-button"
			aria-haspopup="dialog"
			aria-label="New Butler job"
			title="New Butler job: a task Butler does end to end in its own thread"
			onClick={() => {
				jobComposerOpen.value = true;
			}}
		>
			<Briefcase size={16} />
		</button>
	);
}

function ReportButton() {
	return (
		<button
			type="button"
			class="icon-button"
			aria-haspopup="dialog"
			aria-label="Schedule a report with Butler"
			title="Ask Butler for a daily report on the board, as one of his scheduled jobs"
			onClick={() => openReportRequest()}
		>
			<CalendarClock size={16} />
		</button>
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
				<WaitingApprovalsButton />
				<NextNeedingYou />
				<TidyButton />
				<ProjectsButton />
				<ButlerRequestButton request="snooze" />
				<NewJobButton />
				<ReportButton />
				<AnnounceButton />
				<PermissionSurveyButton />
				<NotificationsMenu />
				<NotifyToggle />
				<BoardSettingsButton />
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
					aria-label="New session"
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
