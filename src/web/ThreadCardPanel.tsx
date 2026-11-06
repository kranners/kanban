import "./comments.css";
import "./butler.css";
import {
	ArrowUp,
	CircleAlert,
	ExternalLink,
	ShieldAlert,
	Wrench,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ButlerThreadEvent, ButlerThreadView } from "../shared/types.ts";
import { ApprovalCardView } from "./Approvals.tsx";
import { ActivityBadge } from "./activity.tsx";
import { current } from "./annotations.ts";
import { ButlerAvatar, ButlerMark } from "./Butler.tsx";
import { butlerPresence } from "./butler.ts";
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
					{view.approvals.map((approval) =>
						approval.code ? (
							<ApprovalCardView
								key={`${approval.code}`}
								thread={card.thread.id}
								approval={approval}
								onAnswered={props.onSent}
							/>
						) : (
							<p
								class="comment-footnote"
								key={`${approval.at}-${approval.headline}`}
							>
								{approval.headline}: answer in Discord.
							</p>
						),
					)}
					<p class="comment-footnote">
						Approve and Decline here count as your own answer, as the Discord
						buttons do. Nothing typed here approves anything.
					</p>
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

/** One of Butler's Discord threads, opened from its card: its log, what waits on Aaron, and a reply box. */
function ThreadCardPanel(props: {
	thread: string;
	onClose: () => void;
}): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const [view, setView] = useState<ButlerThreadView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	useRestoreFocus();

	useEffect(() => {
		dialog.current?.showModal();
	}, []);

	useEffect(() => {
		let live = true;
		const load = async () => {
			const got = await fetchThreadView(props.thread);
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
	}, [props.thread, reload]);

	const card = view?.card;
	return (
		<dialog
			class="focus-dialog thread-card-dialog"
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
			{view && (
				<ThreadView view={view} onSent={() => setReload((n) => n + 1)} />
			)}
		</dialog>
	);
}

export function ThreadCardPanelHost(): JSX.Element | null {
	const thread = openThreadCard.value;
	if (!thread) return null;
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
