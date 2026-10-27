import "./actions.css";
import {
	CircleAlert,
	Folder,
	LoaderCircle,
	Plus,
	SquareDashed,
	Sticker,
	StickyNote,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Point } from "../shared/types.ts";
import { cycle, isQuickPromptKey } from "./actions.ts";
import { addNote, annotationMenu, stickerPicker } from "./annotations.ts";
import { boardPointAt, clientPointOf, view } from "./Canvas.tsx";
import { composer, threadMenu } from "./comments.ts";
import { exitAsk } from "./exits.ts";
import { directoryName } from "./focus/paths.ts";
import { moveMenuFocus } from "./menuFocus.ts";
import { sessionSize } from "./placement.ts";
import { regionDialog, regionMenu } from "./regionState.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import type { QuickPrompt } from "./spawns.ts";
import { focusedSessionId, newSessionOpen } from "./state.ts";

let pointer: { x: number; y: number } | null = null;

export function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("input, textarea, select, [contenteditable]") !== null
	);
}

export function blocked(): boolean {
	return (
		focusedSessionId.peek() !== null ||
		newSessionOpen.peek() ||
		exitAsk.peek() !== null ||
		quickPrompt.peek() !== null ||
		annotationMenu.peek() !== null ||
		stickerPicker.peek() !== null ||
		regionMenu.peek() !== null ||
		regionDialog.peek() !== null ||
		composer.peek() !== null ||
		threadMenu.peek() !== null ||
		document.querySelector("dialog[open]") !== null
	);
}

function promptPoint(stage: Element) {
	const box = stage.getBoundingClientRect();
	const inside =
		pointer &&
		pointer.x >= box.left &&
		pointer.x <= box.right &&
		pointer.y >= box.top &&
		pointer.y <= box.bottom;
	const client =
		inside && pointer
			? pointer
			: { x: box.left + box.width / 2, y: box.top + box.height / 3 };
	return boardPointAt(client.x, client.y);
}

export function pointerTarget(): { board: Point; client: Point } | null {
	const menu = boardMenu.peek();
	if (menu) {
		boardMenu.value = null;
		return { board: menu.board, client: menu.client };
	}
	const stage = document.querySelector(".viewport");
	const board = stage ? promptPoint(stage) : null;
	const client = board ? clientPointOf(board) : null;
	return board && client ? { board, client } : null;
}

function startFromKeyboard(): void {
	const point = pointerTarget()?.board;
	if (!point || !openQuickPrompt(point)) newSessionOpen.value = true;
}

export function useBoardGestures(): void {
	useEffect(() => {
		const track = (event: PointerEvent) => {
			pointer = { x: event.clientX, y: event.clientY };
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isQuickPromptKey(event, isTyping(event.target)) || blocked()) return;
			event.preventDefault();
			startFromKeyboard();
		};
		const onContextMenu = (event: MouseEvent) => {
			const target = event.target as Element;
			if (!target.closest(".viewport")) return;
			if (target.closest("[data-node], [data-no-pan], input, textarea, a"))
				return;
			const point = boardPointAt(event.clientX, event.clientY);
			if (!point) return;
			event.preventDefault();
			openBoardMenu({ x: event.clientX, y: event.clientY }, point);
		};
		addEventListener("pointermove", track, { passive: true });
		addEventListener("keydown", onKeyDown);
		addEventListener("contextmenu", onContextMenu);
		return () => {
			removeEventListener("pointermove", track);
			removeEventListener("keydown", onKeyDown);
			removeEventListener("contextmenu", onContextMenu);
		};
	}, []);
}

import {
	boardMenu,
	ghosts,
	openBoardMenu,
	openQuickPrompt,
	quickPrompt,
	spawnFromPrompt,
} from "./spawns.ts";

export function BoardMenu(): JSX.Element | null {
	const menu = boardMenu.value;
	const list = useRef<HTMLDivElement>(null);
	useRestoreFocus(menu !== null);

	useEffect(() => {
		if (!menu) return;
		list.current?.querySelector("button")?.focus();
		const close = () => {
			boardMenu.value = null;
		};
		const closeOutside = (event: PointerEvent) => {
			if (!list.current?.contains(event.target as Node)) close();
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
			else if (list.current) moveMenuFocus(list.current, event);
		};
		const startView = view.peek();
		const stopWatchingView = view.subscribe((v) => {
			if (v !== startView) close();
		});
		addEventListener("pointerdown", closeOutside, true);
		addEventListener("keydown", closeOnEscape);
		addEventListener("resize", close);
		addEventListener("blur", close);
		return () => {
			stopWatchingView();
			removeEventListener("pointerdown", closeOutside, true);
			removeEventListener("keydown", closeOnEscape);
			removeEventListener("resize", close);
			removeEventListener("blur", close);
		};
	}, [menu]);

	if (!menu) return null;
	const left = Math.min(menu.client.x, innerWidth - 240);
	const top = Math.min(menu.client.y, innerHeight - 160);
	return (
		<div
			class="board-menu"
			role="menu"
			ref={list}
			style={{ left: `${left}px`, top: `${top}px` }}
			onContextMenu={(event) => event.preventDefault()}
		>
			<button
				type="button"
				role="menuitem"
				class="board-menu-item"
				onClick={() => openQuickPrompt(menu.board)}
			>
				<Plus size={14} aria-hidden="true" />
				<span class="board-menu-label">
					{menu.group ? `New session in ${menu.group.project}` : "New session"}
				</span>
				<kbd>A</kbd>
			</button>
			<button
				type="button"
				role="menuitem"
				class="board-menu-item"
				onClick={() => {
					boardMenu.value = null;
					addNote(menu.board);
				}}
			>
				<StickyNote size={14} aria-hidden="true" />
				<span class="board-menu-label">Add note here</span>
				<kbd>N</kbd>
			</button>
			<button
				type="button"
				role="menuitem"
				class="board-menu-item"
				onClick={() => {
					boardMenu.value = null;
					stickerPicker.value = { client: menu.client, board: menu.board };
				}}
			>
				<Sticker size={14} aria-hidden="true" />
				<span class="board-menu-label">Add sticker here</span>
				<kbd>S</kbd>
			</button>
			<button
				type="button"
				role="menuitem"
				class="board-menu-item"
				onClick={() => {
					boardMenu.value = null;
					regionDialog.value = { mode: "create", at: menu.board };
				}}
			>
				<SquareDashed size={14} aria-hidden="true" />
				<span class="board-menu-label">New project region here</span>
				<kbd>R</kbd>
			</button>
		</div>
	);
}

function QuickPromptCard(props: { open: QuickPrompt }): JSX.Element {
	const { open } = props;
	const input = useRef<HTMLInputElement>(null);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { k } = view.value;
	const legible = Math.max(1, 1 / k);
	useRestoreFocus();

	useEffect(() => {
		input.current?.focus({ preventScroll: true });
	}, []);

	const cancel = () => {
		if (!busy) quickPrompt.value = null;
	};

	const submit = async () => {
		const text = prompt.trim();
		if (!text || busy) return;
		setBusy(true);
		setError(null);
		const failure = await spawnFromPrompt(text);
		setBusy(false);
		if (failure) {
			setError(failure);
			input.current?.focus();
		}
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			cancel();
		} else if (event.key === "Enter") {
			event.preventDefault();
			void submit();
		} else if (event.key === "Tab" && open.cwds.length > 1) {
			event.preventDefault();
			const cwd = cycle(open.cwds, open.cwd, event.shiftKey ? -1 : 1);
			if (cwd) quickPrompt.value = { ...open, cwd };
		}
	};

	return (
		<div
			class="quick-prompt"
			data-no-pan
			style={{
				transform: `translate(${open.at.x}px, ${open.at.y}px) scale(${legible})`,
				width: `min(${sessionSize.w}px, calc((100vw - 32px) / ${legible * k}))`,
			}}
		>
			<div class={`quick-prompt-field${busy ? " busy" : ""}`}>
				<input
					ref={input}
					type="text"
					value={prompt}
					onInput={(event) => setPrompt(event.currentTarget.value)}
					onKeyDown={onKeyDown}
					onBlur={() => {
						if (!prompt.trim() && !busy) quickPrompt.value = null;
					}}
					placeholder="What should Claude work on?"
					aria-label="Prompt for a new session"
					disabled={busy}
					spellcheck={false}
					autocomplete="off"
				/>
				{busy && (
					<LoaderCircle size={14} class="focus-spin" aria-hidden="true" />
				)}
			</div>
			<div class="quick-prompt-meta">
				<span class="cwd-chip" title={open.cwd}>
					<Folder size={11} aria-hidden="true" />
					{directoryName(open.cwd) || open.cwd}
				</span>
				<span class="quick-prompt-hint">
					{open.cwds.length > 1 && (
						<>
							<kbd>Tab</kbd> folder ·{" "}
						</>
					)}
					<kbd>Enter</kbd> start · <kbd>Esc</kbd> cancel
				</span>
			</div>
			{error && (
				<div class="quick-prompt-error" role="alert">
					<CircleAlert size={13} aria-hidden="true" />
					<p>{error}</p>
				</div>
			)}
		</div>
	);
}

function GhostCards(): JSX.Element {
	return (
		<>
			{ghosts.value.map((ghost) => (
				<div
					key={ghost.short}
					class="ghost-card"
					data-no-pan
					role="status"
					style={{
						transform: `translate(${ghost.at.x}px, ${ghost.at.y}px)`,
						width: `${sessionSize.w}px`,
						height: `${sessionSize.h}px`,
					}}
				>
					<div class="label">
						<div class="label-name">{ghost.prompt}</div>
						<div class="label-doing">Starting session…</div>
					</div>
					<div class="ghost-frame">
						<LoaderCircle size={18} class="focus-spin" aria-hidden="true" />
					</div>
				</div>
			))}
		</>
	);
}

export function SpawnLayer(): JSX.Element {
	const open = quickPrompt.value;
	return (
		<>
			<GhostCards />
			{open && (
				<QuickPromptCard key={`${open.at.x},${open.at.y}`} open={open} />
			)}
		</>
	);
}
