import "./approvals.css";
import { signal } from "@preact/signals";
import { Check, ShieldAlert, ShieldCheck, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
	ButlerThreadApproval,
	ButlerWaitingApproval,
} from "../shared/types.ts";
import {
	answerApproval,
	approveAll,
	fetchApprovals,
	holdMs,
	parseApprovalBody,
} from "./approvalCard.ts";
import { needing, visitNextNeedingYou } from "./attentionState.ts";
import { openThreadCard } from "./butlerThreads.ts";
import { holdReload, reloadPage } from "./pageBuild.ts";
import { useRestoreFocus } from "./restoreFocus.ts";

// Approving Butler's requests from the board: each request's card laid out
// as Discord shows it, with Approve and Decline that count as Aaron's own
// press, Approve held for a second on anything critical, and the Waiting on
// you panel, which lists every request with Approve all.

/** Whether the Waiting on you panel is open. */
export const approvalsOpen = signal(false);

/** The requests waiting, as the board last listed them, for the count on the region and top bar. */
export const waitingApprovals = signal<ButlerWaitingApproval[]>([]);

const pollMs = 5000;

/** Keeps the waiting requests fresh while the board is open. */
export function useWaitingApprovals(): void {
	useEffect(() => {
		let live = true;
		const load = async () => {
			const got = await fetchApprovals();
			if (live && got.ok) waitingApprovals.value = got.value.approvals;
		};
		void load();
		const timer = setInterval(() => void load(), pollMs);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, []);
}

/** Reloads the page, keeping where Aaron was, after a press it couldn't send. */
function ReloadButton(): JSX.Element {
	return (
		<button type="button" class="approval-reload" onClick={reloadPage}>
			Reload
		</button>
	);
}

/** A button that acts only once held for `ms`, a ring filling as it is held. */
export function HoldButton(props: {
	ms: number;
	label: string;
	class?: string;
	disabled?: boolean;
	onDone: () => void;
	children: JSX.Element | JSX.Element[] | string;
}): JSX.Element {
	const [holding, setHolding] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const release = useRef<(() => void) | null>(null);
	const start = () => {
		if (props.disabled || timer.current) return;
		setHolding(true);
		// A reload for a new build waits until the hold is over.
		release.current = holdReload();
		timer.current = setTimeout(() => {
			timer.current = null;
			setHolding(false);
			props.onDone();
			release.current?.();
		}, props.ms);
	};
	const stop = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		release.current?.();
		release.current = null;
		setHolding(false);
	};
	useEffect(() => stop, []);
	return (
		<button
			type="button"
			class={`approval-hold${holding ? " holding" : ""} ${props.class ?? ""}`}
			style={{ "--hold-ms": `${props.ms}ms` }}
			disabled={props.disabled}
			aria-label={`${props.label}: press and hold`}
			title={`${props.label}: press and hold for a second`}
			onPointerDown={(event) => {
				event.currentTarget.setPointerCapture?.(event.pointerId);
				start();
			}}
			onPointerUp={stop}
			onPointerCancel={stop}
			onPointerLeave={stop}
			onKeyDown={(event) => {
				if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
					event.preventDefault();
					start();
				}
			}}
			onKeyUp={(event) => {
				if (event.key === "Enter" || event.key === " ") stop();
			}}
			onClick={(event) => event.preventDefault()}
		>
			<svg class="approval-ring" viewBox="0 0 20 20" aria-hidden="true">
				<circle cx="10" cy="10" r="8" />
			</svg>
			{props.children}
		</button>
	);
}

/** One request as its card: what asks, the goal, Needs your approval, Also included, Limits, and its buttons. */
export function ApprovalCardView(props: {
	thread: string;
	title?: string;
	approval: ButlerThreadApproval;
	onAnswered?: (text: string) => void;
}): JSX.Element {
	const { approval } = props;
	const sections = parseApprovalBody(approval.body);
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<{
		ok: boolean;
		text: string;
		reload?: boolean;
	} | null>(null);
	const pressed = approval.pressed;
	const answer = async (decision: "approve" | "decline", held: boolean) => {
		setBusy(true);
		const got = await answerApproval(props.thread, approval, decision, held);
		setBusy(false);
		const text = got.ok ? got.value.text : got.error;
		setSaid({ ok: got.ok, text, reload: !got.ok && got.reload === true });
		if (got.ok) props.onAnswered?.(text);
	};
	const critical = approval.critical === true;
	const done = said?.ok || pressed !== undefined;
	return (
		<article
			class={`approval-card${critical ? " approval-critical" : ""}`}
			aria-label={approval.headline}
		>
			<header class="approval-title">
				{critical ? (
					<ShieldAlert size={14} aria-hidden="true" />
				) : (
					<ShieldCheck size={14} aria-hidden="true" />
				)}
				<span>{approval.headline}</span>
				{props.title && (
					<button
						type="button"
						class="approval-from"
						onClick={() => {
							openThreadCard.value = props.thread;
						}}
					>
						{props.title}
					</button>
				)}
			</header>
			{sections.goal && (
				<p class="approval-goal">
					<strong>Goal:</strong> {sections.goal}
				</p>
			)}
			{sections.critical.length > 0 ? (
				<section class="approval-needs">
					<h4>Needs your approval</h4>
					<ul>
						{sections.critical.map((item) => (
							<li key={`${item.glyph}-${item.capability}-${item.touches}`}>
								<span class="approval-glyph" aria-hidden="true">
									{item.glyph}
								</span>
								<span>
									<strong>{item.capability}</strong>
									{item.touches && <small>{item.touches}</small>}
								</span>
							</li>
						))}
					</ul>
				</section>
			) : (
				sections.noCritical && (
					<section class="approval-needs approval-none">
						<h4>Needs your approval</h4>
						<p>No critical permissions</p>
					</section>
				)
			)}
			{sections.included.length > 0 && (
				<section class="approval-list">
					<h4>Also included</h4>
					<ul>
						{sections.included.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</section>
			)}
			{sections.limits.length > 0 && (
				<section class="approval-list">
					<h4>Limits</h4>
					<ul>
						{sections.limits.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</section>
			)}
			{sections.other.length > 0 && (
				<p class="approval-other">{sections.other.join("\n")}</p>
			)}
			{done ? (
				<p class="approval-said" role="status">
					{said?.text ??
						`${pressed?.decision === "decline" ? "Declined" : "Approved"} from the board; waiting for Butler to take it`}
				</p>
			) : approval.answerable ? (
				<footer class="approval-buttons">
					{critical ? (
						<HoldButton
							ms={holdMs}
							label="Approve"
							class="approval-approve"
							disabled={busy}
							onDone={() => void answer("approve", true)}
						>
							<Check size={14} aria-hidden="true" />
							<span>Hold to approve</span>
						</HoldButton>
					) : (
						<button
							type="button"
							class="approval-approve"
							disabled={busy}
							onClick={() => void answer("approve", false)}
						>
							<Check size={14} aria-hidden="true" />
							<span>Approve</span>
						</button>
					)}
					<button
						type="button"
						class="approval-decline"
						disabled={busy}
						onClick={() => void answer("decline", false)}
					>
						<X size={14} aria-hidden="true" />
						<span>Decline</span>
					</button>
				</footer>
			) : (
				<p class="comment-footnote">Answer this one in Discord.</p>
			)}
			{said && !said.ok && (
				<p class="comment-error" role="alert">
					{said.text}
					{said.reload && <ReloadButton />}
				</p>
			)}
		</article>
	);
}

/** The count of waiting requests, which opens the Waiting on you panel. */
export function WaitingApprovalsButton(props: {
	class?: string;
}): JSX.Element | null {
	const count = waitingApprovals.value.filter(
		(w) => !w.approval.pressed,
	).length;
	if (count === 0) return null;
	return (
		<button
			type="button"
			class={`approvals-button ${props.class ?? ""}`}
			aria-haspopup="dialog"
			title="Butler's requests waiting on you: review and approve them here"
			onClick={(event) => {
				event.stopPropagation();
				approvalsOpen.value = true;
			}}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<ShieldAlert size={12} aria-hidden="true" />
			<span class="num">{count}</span>
			<span>{count === 1 ? "approval" : "approvals"}</span>
		</button>
	);
}

/** Every request waiting on Aaron, with Approve all, and the board's own sessions waiting on a prompt. */
function ApprovalsPanel(props: { onClose: () => void }): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const [result, setResult] = useState<{
		approved: number;
		critical: { key: string; text: string }[];
		left: (ButlerWaitingApproval & { why: string })[];
	} | null>(null);
	const [error, setError] = useState<{
		text: string;
		reload: boolean;
	} | null>(null);
	const [busy, setBusy] = useState(false);
	useRestoreFocus();
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const all = waitingApprovals.value;
	const open = all.filter((w) => !w.approval.pressed);
	// Approve all takes every answerable request, critical ones included, with no confirm.
	const approvable = open.filter((w) => w.approval.answerable);
	const sessions = needing.value.size;
	const runAll = async () => {
		setBusy(true);
		// Only what the panel shows now: a request arriving after this press waits for its own answer.
		const got = await approveAll(
			approvable.map((w) => w.approval.code ?? "").filter(Boolean),
		);
		setBusy(false);
		if (!got.ok) {
			setError({ text: got.error, reload: got.reload === true });
			return;
		}
		setError(null);
		setResult({
			approved: got.value.approved.length,
			critical: got.value.approved
				.filter((w) => w.approval.critical)
				.map((w) => ({
					key: `${w.thread}-${w.approval.code}`,
					text: `${w.title || "A thread"}: ${w.approval.headline}`,
				})),
			left: got.value.left,
		});
		const refreshed = await fetchApprovals();
		if (refreshed.ok) waitingApprovals.value = refreshed.value.approvals;
	};
	return (
		<dialog
			class="focus-dialog approvals-dialog"
			ref={dialog}
			onClose={props.onClose}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					props.onClose();
				}
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) props.onClose();
			}}
			aria-label="Waiting on you"
		>
			<header class="comment-thread-head approvals-head">
				<ShieldAlert size={16} aria-hidden="true" />
				<span class="comment-thread-title">Waiting on you</span>
				<button
					type="button"
					class="approvals-all"
					disabled={busy || approvable.length === 0}
					title="Approve every request waiting on you, critical ones included"
					onClick={() => void runAll()}
				>
					<ShieldCheck size={14} aria-hidden="true" />
					Approve all
				</button>
				<button
					type="button"
					class="icon-button"
					aria-label="Close"
					onClick={props.onClose}
				>
					<X size={14} />
				</button>
			</header>
			<div class="approvals-body" data-scrollable>
				{error && (
					<p class="comment-error" role="alert">
						{error.text}
						{error.reload && <ReloadButton />}
					</p>
				)}
				{result && (
					<section class="approvals-result" role="status">
						<p>
							Approved {result.approved} request
							{result.approved === 1 ? "" : "s"}
							{result.critical.length > 0 &&
								`, ${result.critical.length} of them critical`}
							. Butler acts on them as spike takes them, so there is no undo
							from here.
						</p>
						{result.critical.length > 0 && (
							<ul class="approvals-result-critical">
								{result.critical.map((c) => (
									<li key={c.key}>{c.text}</li>
								))}
							</ul>
						)}
						{result.left.length > 0 && (
							<p>Left {result.left.length} for you:</p>
						)}
						{result.left.length > 0 && (
							<ul>
								{result.left.map((w) => (
									<li key={`${w.thread}-${w.approval.code}`}>
										{w.approval.headline} <small>({w.why})</small>
									</li>
								))}
							</ul>
						)}
					</section>
				)}
				{sessions > 0 && (
					<section class="approvals-sessions">
						<p>
							{sessions} board session{sessions === 1 ? "" : "s"} wait
							{sessions === 1 ? "s" : ""} on a prompt. The board allows a cloud
							session's harmless prompts itself, so a cloud session still
							waiting has a serious one, also asked in Discord; a terminal
							session's prompt waits for you there.
						</p>
						<button
							type="button"
							onClick={() => {
								props.onClose();
								visitNextNeedingYou();
							}}
						>
							Go to the next one
						</button>
					</section>
				)}
				{open.length === 0 && sessions === 0 && (
					<p class="comment-footnote">Nothing is waiting on you.</p>
				)}
				{open.map((w) => (
					<ApprovalCardView
						key={`${w.thread}-${w.approval.code}`}
						thread={w.thread}
						title={w.title}
						approval={w.approval}
					/>
				))}
			</div>
		</dialog>
	);
}

export function ApprovalsHost(): JSX.Element | null {
	useWaitingApprovals();
	if (!approvalsOpen.value) return null;
	return (
		<ApprovalsPanel
			onClose={() => {
				approvalsOpen.value = false;
			}}
		/>
	);
}
