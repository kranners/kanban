import "./comments.css";
import {
	ArrowUp,
	Bot,
	Check,
	CircleAlert,
	CircleCheck,
	LoaderCircle,
	MessageSquare,
	RotateCcw,
	Square,
	Trash2,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CommentEvent, CommentThread } from "../shared/types.ts";
import { boardPointAt, clientPointOf, view } from "./Canvas.tsx";
import {
	composer,
	isCommentKey,
	movePin,
	openThread,
	openThreadId,
	pinned,
	pinState,
	previewPin,
	remove,
	reply,
	resolve,
	startThread,
	stop,
	threadMenu,
	threadTitle,
} from "./comments.ts";
import { moveMenuFocus } from "./menuFocus.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { blocked, isTyping, pointerTarget } from "./Spawning.tsx";

const dragThreshold = 4;
const panelWidth = 360;
const panelGap = 12;
let justDragged = false;

function grabPin(event: PointerEvent, thread: CommentThread): void {
	if (event.button !== 0) return;
	const element = event.currentTarget as HTMLElement;
	const start = { x: event.clientX, y: event.clientY };
	let dragging = false;
	let latest = { x: thread.x, y: thread.y };
	element.setPointerCapture(event.pointerId);
	const move = (next: PointerEvent) => {
		if (next.pointerId !== event.pointerId) return;
		const dx = next.clientX - start.x;
		const dy = next.clientY - start.y;
		if (!dragging && Math.hypot(dx, dy) < dragThreshold) return;
		dragging = true;
		const { k } = view.peek();
		latest = { x: thread.x + dx / k, y: thread.y + dy / k };
		previewPin(thread.id, latest);
	};
	const finish = (next: PointerEvent) => {
		if (next.pointerId !== event.pointerId) return;
		element.removeEventListener("pointermove", move);
		element.removeEventListener("pointerup", finish);
		element.removeEventListener("pointercancel", finish);
		if (!dragging) return;
		void movePin(
			thread.id,
			next.type === "pointercancel" ? { x: thread.x, y: thread.y } : latest,
		);
		justDragged = true;
		setTimeout(() => {
			justDragged = false;
		}, 0);
	};
	element.addEventListener("pointermove", move);
	element.addEventListener("pointerup", finish);
	element.addEventListener("pointercancel", finish);
}

const stateLabels = {
	running: "Working",
	failed: "Stopped with an error",
	resolved: "Resolved",
	answered: "Answered",
};

function PinIcon(props: { thread: CommentThread }): JSX.Element {
	const state = pinState(props.thread);
	if (state === "running") {
		return <LoaderCircle size={16} class="spin" aria-hidden="true" />;
	}
	if (state === "resolved") return <Check size={16} aria-hidden="true" />;
	if (state === "failed") return <CircleAlert size={16} aria-hidden="true" />;
	return <Bot size={16} aria-hidden="true" />;
}

function Pin(props: { thread: CommentThread; open: boolean }): JSX.Element {
	const { thread } = props;
	const state = pinState(thread);
	const scale = 1 / view.value.k;
	return (
		<button
			type="button"
			class={`comment-pin pin-${state}${props.open ? " open" : ""}`}
			style={{
				transform: `translate(${thread.x}px, ${thread.y}px) scale(${scale})`,
			}}
			data-no-pan
			data-comment={thread.id}
			aria-label={`${threadTitle(thread)}: ${stateLabels[state]}`}
			aria-expanded={props.open}
			title={threadTitle(thread)}
			onPointerDown={(event) => grabPin(event, thread)}
			onClick={() => {
				if (justDragged) return;
				openThreadId.value = props.open ? null : thread.id;
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				event.stopPropagation();
				threadMenu.value = {
					id: thread.id,
					client: { x: event.clientX, y: event.clientY },
				};
			}}
			onKeyDown={(event) => {
				if (event.key === "Delete" || event.key === "Backspace") {
					event.preventDefault();
					event.stopPropagation();
					void remove(thread.id);
				}
			}}
		>
			<span class="comment-pin-body">
				<PinIcon thread={thread} />
			</span>
		</button>
	);
}

export function CommentLayer(): JSX.Element {
	const open = openThreadId.value;
	return (
		<>
			{pinned.value.map((thread) => (
				<Pin key={thread.id} thread={thread} open={open === thread.id} />
			))}
		</>
	);
}

function Composer(): JSX.Element | null {
	const at = composer.value;
	const field = useRef<HTMLTextAreaElement>(null);
	const panel = useRef<HTMLFormElement>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	useRestoreFocus(at !== null);

	useEffect(() => {
		setText("");
		setError(null);
		setSending(false);
		if (at) field.current?.focus({ preventScroll: true });
	}, [at]);

	useEffect(() => {
		if (!at) return;
		const closeOutside = (event: PointerEvent) => {
			if (!panel.current?.contains(event.target as Node)) composer.value = null;
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [at]);

	if (!at) return null;
	const client = clientPointOf(at.board) ?? at.client;
	const left = Math.max(
		8,
		Math.min(client.x + panelGap, innerWidth - panelWidth - 8),
	);
	const top = Math.max(8, Math.min(client.y - 20, innerHeight - 180));
	const submit = async () => {
		const message = text.trim();
		if (!message || sending) return;
		setSending(true);
		const started = await startThread(at.board, message);
		if (started.ok) composer.value = null;
		else {
			setSending(false);
			setError(started.error);
		}
	};
	return (
		<form
			class="comment-composer"
			ref={panel}
			style={{ left: `${left}px`, top: `${top}px` }}
			aria-label="Ask the board agent"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<span class="comment-composer-pin" aria-hidden="true">
				<Bot size={14} />
			</span>
			<textarea
				ref={field}
				class="comment-input"
				rows={2}
				value={text}
				maxLength={4000}
				placeholder="Ask the board agent: organise my board into projects, report on a session…"
				aria-label="Message for the board agent"
				onInput={(event) => setText(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.isComposing) return;
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						composer.value = null;
					} else if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						void submit();
					}
				}}
			/>
			<div class="comment-composer-foot">
				{error ? (
					<span class="comment-error" role="alert">
						{error}
					</span>
				) : (
					<span class="comment-hint">
						<kbd>Enter</kbd> sends · <kbd>Shift Enter</kbd> new line
					</span>
				)}
				<button
					type="submit"
					class="icon-button comment-send"
					disabled={!text.trim() || sending}
					aria-label="Send"
					title="Send"
				>
					{sending ? (
						<LoaderCircle size={15} class="spin" />
					) : (
						<ArrowUp size={15} />
					)}
				</button>
			</div>
		</form>
	);
}

function EventLine(props: { event: CommentEvent }): JSX.Element {
	const { event } = props;
	if (event.kind === "user") {
		return <p class="comment-event event-user">{event.text}</p>;
	}
	if (event.kind === "reply") {
		return <p class="comment-event event-reply">{event.text}</p>;
	}
	if (event.kind === "error") {
		return (
			<p class="comment-event event-error">
				<CircleAlert size={13} aria-hidden="true" />
				{event.text}
			</p>
		);
	}
	return (
		<p class={`comment-event event-action action-${event.state}`}>
			{event.state === "running" ? (
				<LoaderCircle size={13} class="spin" aria-hidden="true" />
			) : event.state === "done" ? (
				<CircleCheck size={13} aria-hidden="true" />
			) : (
				<CircleAlert size={13} aria-hidden="true" />
			)}
			<span>{event.text}</span>
		</p>
	);
}

function ThreadPanel(): JSX.Element | null {
	const thread = openThread.value;
	const panel = useRef<HTMLElement>(null);
	const log = useRef<HTMLDivElement>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const id = thread?.id ?? null;
	const count = thread?.events.length ?? 0;

	useEffect(() => {
		setText("");
		setError(null);
	}, [id]);

	useEffect(() => {
		const element = log.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [id, count]);

	useEffect(() => {
		if (!id) return;
		const closeOutside = (event: PointerEvent) => {
			const target = event.target as Element;
			if (panel.current?.contains(target)) return;
			if (target.closest(`[data-comment="${id}"], .board-menu`)) return;
			openThreadId.value = null;
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [id]);

	if (!thread) return null;
	const anchor = clientPointOf(thread) ?? {
		x: innerWidth / 2,
		y: innerHeight / 2,
	};
	const right = anchor.x + 24 + panelGap + panelWidth < innerWidth;
	const left = right
		? anchor.x + 24 + panelGap
		: Math.max(8, anchor.x - panelGap - panelWidth);
	const top = Math.max(8, Math.min(anchor.y - 40, innerHeight - 420));
	const send = async () => {
		const message = text.trim();
		if (!message) return;
		const sent = await reply(thread.id, message);
		if (sent.ok) setText("");
		else setError(sent.error);
	};
	return (
		<section
			class="comment-thread"
			ref={panel}
			style={{ left: `${left}px`, top: `${top}px` }}
			aria-label={`Comment: ${threadTitle(thread)}`}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					openThreadId.value = null;
				}
			}}
		>
			<header class="comment-thread-head">
				<Bot size={15} aria-hidden="true" />
				<span class="comment-thread-title">Board agent</span>
				<span class={`comment-status status-${pinState(thread)}`}>
					{stateLabels[pinState(thread)]}
				</span>
				<button
					type="button"
					class="icon-button"
					aria-label={thread.resolved ? "Reopen" : "Resolve"}
					title={thread.resolved ? "Reopen" : "Resolve"}
					onClick={() => void resolve(thread.id, !thread.resolved)}
				>
					{thread.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
				</button>
				<button
					type="button"
					class="icon-button"
					aria-label="Delete comment"
					title="Delete comment"
					onClick={() => void remove(thread.id)}
				>
					<Trash2 size={14} />
				</button>
				<button
					type="button"
					class="icon-button"
					aria-label="Close"
					title="Close (Esc)"
					onClick={() => {
						openThreadId.value = null;
					}}
				>
					<X size={14} />
				</button>
			</header>
			<div class="comment-log" ref={log} data-scrollable aria-live="polite">
				{thread.events.map((event, index) => (
					<EventLine key={`${event.at}-${index}`} event={event} />
				))}
			</div>
			<form
				class="comment-reply"
				onSubmit={(event) => {
					event.preventDefault();
					void send();
				}}
			>
				<textarea
					class="comment-input"
					rows={1}
					value={text}
					maxLength={4000}
					placeholder={thread.running ? "Working…" : "Reply"}
					aria-label="Reply to the board agent"
					disabled={thread.running}
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
				{thread.running ? (
					<button
						type="button"
						class="icon-button comment-stop"
						aria-label="Stop the agent"
						title="Stop"
						onClick={() => void stop(thread.id)}
					>
						<Square size={13} />
					</button>
				) : (
					<button
						type="submit"
						class="icon-button comment-send"
						disabled={!text.trim()}
						aria-label="Send"
						title="Send"
					>
						<ArrowUp size={15} />
					</button>
				)}
			</form>
			{error && (
				<p class="comment-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

function ThreadMenu(): JSX.Element | null {
	const menu = threadMenu.value;
	const list = useRef<HTMLDivElement>(null);
	useRestoreFocus(menu !== null);

	useEffect(() => {
		if (!menu) return;
		list.current?.querySelector("button")?.focus();
		const close = () => {
			threadMenu.value = null;
		};
		const closeOutside = (event: PointerEvent) => {
			if (!list.current?.contains(event.target as Node)) close();
		};
		addEventListener("pointerdown", closeOutside, true);
		addEventListener("blur", close);
		return () => {
			removeEventListener("pointerdown", closeOutside, true);
			removeEventListener("blur", close);
		};
	}, [menu]);

	if (!menu) return null;
	const thread = pinned.value.find((t) => t.id === menu.id);
	if (!thread) return null;
	const choose = (action: () => void) => () => {
		threadMenu.value = null;
		action();
	};
	return (
		<div
			class="board-menu"
			role="menu"
			ref={list}
			style={{
				left: `${Math.min(menu.client.x, innerWidth - 212)}px`,
				top: `${Math.min(menu.client.y, innerHeight - 124)}px`,
			}}
			onContextMenu={(event) => event.preventDefault()}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					threadMenu.value = null;
				} else if (list.current) moveMenuFocus(list.current, event);
			}}
		>
			<button
				type="button"
				role="menuitem"
				class="board-menu-item"
				onClick={choose(() => {
					openThreadId.value = thread.id;
				})}
			>
				<MessageSquare size={14} aria-hidden="true" />
				<span class="board-menu-label">Open thread</span>
				<kbd>Enter</kbd>
			</button>
			<button
				type="button"
				role="menuitem"
				class="board-menu-item"
				onClick={choose(() => void resolve(thread.id, !thread.resolved))}
			>
				{thread.resolved ? (
					<RotateCcw size={14} aria-hidden="true" />
				) : (
					<Check size={14} aria-hidden="true" />
				)}
				<span class="board-menu-label">
					{thread.resolved ? "Reopen" : "Resolve"}
				</span>
			</button>
			<span class="board-menu-sep" />
			<button
				type="button"
				role="menuitem"
				class="board-menu-item danger"
				onClick={choose(() => void remove(thread.id))}
			>
				<Trash2 size={14} aria-hidden="true" />
				<span class="board-menu-label">Delete comment</span>
				<kbd>⌫</kbd>
			</button>
		</div>
	);
}

export function CommentOverlays(): JSX.Element {
	return (
		<>
			<Composer />
			<ThreadPanel />
			<ThreadMenu />
		</>
	);
}

function centreTarget() {
	const stage = document.querySelector(".viewport");
	if (!stage) return null;
	const box = stage.getBoundingClientRect();
	const client = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
	const board = boardPointAt(client.x, client.y);
	return board ? { board, client } : null;
}

export function useCommentGestures(): void {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isCommentKey(event, isTyping(event.target)) || blocked()) return;
			const at = pointerTarget() ?? centreTarget();
			if (!at) return;
			event.preventDefault();
			openThreadId.value = null;
			composer.value = at;
		};
		addEventListener("keydown", onKeyDown);
		return () => removeEventListener("keydown", onKeyDown);
	}, []);
}
