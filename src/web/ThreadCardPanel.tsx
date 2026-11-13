import "./comments.css";
import "./butler.css";
import {
	ArrowUp,
	CircleAlert,
	ExternalLink,
	Pin,
	PinOff,
	ShieldAlert,
	Wrench,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ButlerThreadEvent, ButlerThreadView } from "../shared/types.ts";
import { approvalsOpen } from "./Approvals.tsx";
import { ActivityBadge } from "./activity.tsx";
import { current } from "./annotations.ts";
import { ButlerAvatar, ButlerMark } from "./Butler.tsx";
import { butlerPresence } from "./butler.ts";
import { dmPanelPinned } from "./butlerFaceSettings.ts";
import {
	fetchThreadView,
	isFromDm,
	openParent,
	openThreadCard,
	parentTitle,
	replyToThread,
	threadKindLabels,
	threadPollMs,
} from "./butlerThreads.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { now } from "./state.ts";
import { ago } from "./time.ts";

function ThreadEventLine(props: { event: ButlerThreadEvent }): JSX.Element {
	const { event } = props;
	if (event.kind === "user") {
		return (
			<p class="comment-event event-user" title="You">
				{event.text}
			</p>
		);
	}
	if (event.kind === "reply") {
		return <p class="comment-event event-reply">{event.text}</p>;
	}
	if (event.kind === "error") {
		return (
			<p class="comment-event event-error">
				<CircleAlert size={13} aria-hidden="true" />
				<span>{event.text}</span>
			</p>
		);
	}
	if (event.kind === "approval") {
		return (
			<p class="comment-event thread-event-approval">
				<ShieldAlert size={13} aria-hidden="true" />
				<span>{event.text}</span>
			</p>
		);
	}
	if (event.kind === "tool") {
		return (
			<p class="comment-event thread-event-tool">
				<Wrench size={11} aria-hidden="true" />
				<span>{event.text}</span>
			</p>
		);
	}
	return <p class="comment-event thread-event-status">{event.text}</p>;
}

function ThreadReply(props: {
	thread: string;
	dm: boolean;
	onSent: () => void;
}): JSX.Element {
	const prompt = props.dm
		? "Reply to Butler: it goes into your Discord DM"
		: "Reply to Butler in this thread";
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const send = async () => {
		const message = text.trim();
		if (!message || sending) return;
		setSending(true);
		const sent = await replyToThread(props.thread, message);
		setSending(false);
		if (!sent.ok) {
			setError(sent.error);
			return;
		}
		setText("");
		props.onSent();
	};
	return (
		<>
			<form
				class="comment-reply"
				onSubmit={(event) => {
					event.preventDefault();
					void send();
				}}
			>
				<textarea
					class="comment-input"
					rows={2}
					value={text}
					maxLength={4000}
					placeholder={prompt}
					aria-label={prompt}
					onInput={(event) => {
						setText(event.currentTarget.value);
						setError(null);
					}}
					onKeyDown={(event) => {
						if (event.isComposing) return;
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void send();
						}
					}}
				/>
				<button
					type="submit"
					class="icon-button comment-send"
					disabled={!text.trim() || sending}
					aria-label="Send"
					title="Send"
				>
					<ArrowUp size={15} />
				</button>
			</form>
			{error && (
				<p class="comment-error" role="alert">
					{error}
				</p>
			)}
		</>
	);
}

function ThreadView(props: {
	view: ButlerThreadView;
	onSent: () => void;
}): JSX.Element {
	const { view } = props;
	const { card } = view;
	const log = useRef<HTMLDivElement>(null);
	const kind = card.thread.kind;
	const from = isFromDm(
		{ card: card.parent },
		butlerPresence.value.dm?.thread,
		current.value,
	)
		? "DM"
		: parentTitle(card.parent, current.value, "its parent thread");
	useEffect(() => {
		const element = log.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [view.events.length]);
	return (
		<>
			<div class="thread-card-meta">
				<ActivityBadge activity={card.state} />
				<span>{card.status}</span>
				{card.desk && <span class="thread-card-desk">Desk {card.desk}</span>}
				{from && (
					<button
						type="button"
						class="thread-card-parent"
						onClick={() => openParent(card.parent)}
					>
						from {from}
					</button>
				)}
				<span class="thread-card-ago">{ago(card.updatedAt, now.value)}</span>
			</div>
			{view.approvals.length > 0 && (
				<section class="thread-card-waiting" aria-label="Waiting on you">
					<h3>Waiting on you</h3>
					<ul class="thread-card-waiting-list">
						{view.approvals.map((approval) => (
							<li key={`${approval.code ?? approval.at}-${approval.headline}`}>
								{approval.headline}
								{!approval.code && ": answer in Discord"}
							</li>
						))}
					</ul>
					{view.approvals.some((approval) => approval.code) && (
						<button
							type="button"
							class="approvals-all"
							onClick={() => {
								approvalsOpen.value = true;
							}}
						>
							Answer in Waiting on you
						</button>
					)}
				</section>
			)}
			<div
				class="comment-log thread-card-log"
				ref={log}
				data-scrollable
				aria-live="polite"
			>
				{view.events.length === 0 && (
					<p class="comment-footnote">
						Nothing from this thread yet. It is all in Discord.
					</p>
				)}
				{view.events.map((event, index) => (
					<ThreadEventLine key={`${event.at}-${index}`} event={event} />
				))}
			</div>
			{view.children.length > 0 && (
				<section class="thread-card-children" aria-label="Linked">
					<h3>Linked</h3>
					<ul>
						{view.children.map((child) => (
							<li key={`${child.kind}-${child.id}`}>
								<span class="thread-card-child-kind">
									{child.kind === "change"
										? "Change"
										: child.kind === "session"
											? "Session"
											: "Thread"}
								</span>
								{child.kind === "thread" ? (
									<button
										type="button"
										class="thread-card-parent"
										onClick={() => {
											openThreadCard.value = child.id;
										}}
									>
										{child.title}
									</button>
								) : child.link ? (
									<a
										href={child.link}
										target="_blank"
										rel="noopener noreferrer"
									>
										{child.title}
									</a>
								) : (
									<span>{child.title}</span>
								)}
								<span class="thread-card-child-state">{child.state}</span>
							</li>
						))}
					</ul>
				</section>
			)}
			<ThreadReply
				thread={card.thread.id}
				dm={kind === "dm"}
				onSent={props.onSent}
			/>
		</>
	);
}

/** A thread's view, read again every few seconds while it is open; nothing while there is no thread. */
export function useThreadView(thread: string | null) {
	const [view, setView] = useState<ButlerThreadView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	useEffect(() => {
		if (thread === null) return;
		let live = true;
		const load = async () => {
			const got = await fetchThreadView(thread);
			if (!live) return;
			if (got.ok) {
				setView(got.value);
				setError(null);
			} else setError(got.error);
		};
		void load();
		const timer = setInterval(() => void load(), threadPollMs);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [thread, reload]);
	return { view, error, refresh: () => setReload((n) => n + 1) };
}

/** A Butler thread's sections in the board's detail view: its log, what waits on Aaron, what it started and a reply box. */
export function ThreadBody(props: {
	view: ButlerThreadView | null;
	error: string | null;
	refresh: () => void;
}): JSX.Element {
	const { view, error, refresh } = props;
	return (
		<div class="thread-body">
			{error && !view && (
				<p class="comment-error" role="alert">
					{error}
				</p>
			)}
			{view ? (
				<ThreadView view={view} onSent={refresh} />
			) : (
				!error && <p class="comment-footnote">Loading…</p>
			)}
		</div>
	);
}

/** Butler's DM, opened from his face: its log, what waits on Aaron, and a reply box, pinnable beside the board. */
function ThreadCardPanel(props: {
	thread: string;
	onClose: () => void;
}): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const { view, error, refresh } = useThreadView(props.thread);
	// Swapping between modal and pinned closes the dialog for a moment; that close is not Aaron's.
	const swapping = useRef(false);
	useRestoreFocus();

	// The DM's panel may be pinned: then it stays open beside the board,
	// non-modal, through clicks outside, until unpinned or closed. Every
	// other panel, and the DM's unpinned, is modal and closes on Escape or
	// a click outside.
	const isDm = butlerPresence.value.dm?.thread === props.thread;
	const pinned = isDm && dmPanelPinned.value;
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (d.open) {
			swapping.current = true;
			d.close();
		}
		if (pinned) d.show();
		else d.showModal();
	}, [pinned]);

	const card = view?.card;
	return (
		<dialog
			class={`focus-dialog thread-card-dialog${pinned ? " thread-card-pinned" : ""}`}
			ref={dialog}
			onClose={() => {
				if (swapping.current) {
					swapping.current = false;
					return;
				}
				props.onClose();
			}}
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
			aria-label={card ? card.title : "Butler thread"}
		>
			<header class="comment-thread-head thread-card-head">
				{card?.thread.kind === "dm" ? (
					<ButlerAvatar size={18} />
				) : (
					<ButlerMark size={16} />
				)}
				<span class="thread-card-kind">
					{card ? threadKindLabels[card.thread.kind] : "Butler"}
				</span>
				<span class="comment-thread-title thread-card-title">
					{card?.title ?? "Loading…"}
				</span>
				{card?.link && (
					<a
						class="butler-card-link"
						href={card.link}
						target="_blank"
						rel="noopener noreferrer"
					>
						Open in Discord <ExternalLink size={12} aria-hidden="true" />
					</a>
				)}
				{isDm && (
					<button
						type="button"
						class="icon-button"
						aria-pressed={pinned}
						aria-label={pinned ? "Unpin the DM" : "Pin the DM open"}
						title={
							pinned
								? "Unpin: close on Escape or a click outside"
								: "Pin open beside the board"
						}
						onClick={() => {
							dmPanelPinned.value = !pinned;
						}}
					>
						{pinned ? <PinOff size={14} /> : <Pin size={14} />}
					</button>
				)}
				<button
					type="button"
					class="icon-button"
					aria-label="Close"
					title="Close (Esc)"
					onClick={props.onClose}
				>
					<X size={14} />
				</button>
			</header>
			{error && !view && (
				<p class="comment-error" role="alert">
					{error}
				</p>
			)}
			{view && <ThreadView view={view} onSent={refresh} />}
		</dialog>
	);
}

/** The DM's own panel; every other thread opens in the board's detail view. */
export function ThreadCardPanelHost(): JSX.Element | null {
	const thread = openThreadCard.value;
	if (!thread || thread !== butlerPresence.value.dm?.thread) return null;
	return (
		<ThreadCardPanel
			key={thread}
			thread={thread}
			onClose={() => {
				openThreadCard.value = null;
			}}
		/>
	);
}
