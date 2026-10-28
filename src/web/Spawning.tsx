import "./actions.css";
import {
	CircleAlert,
	Folder,
	LoaderCircle,
	Plus,
	SquareDashed,
	Sticker,
	StickyNote,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { maxPromptImages } from "../shared/promptImages.ts";
import type { Point, PromptImage } from "../shared/types.ts";
import { cycle, isQuickPromptKey } from "./actions.ts";
import { addNote, annotationMenu, stickerPicker } from "./annotations.ts";
import { boardPointAt, clientPointOf, view } from "./Canvas.tsx";
import { composer, threadMenu } from "./comments.ts";
import { exitAsk } from "./exits.ts";
import { directoryName } from "./focus/paths.ts";
import { moveMenuFocus } from "./menuFocus.ts";
import { sessionSize } from "./placement.ts";
import { admit, dataUrl, imageFiles, readImages } from "./promptImages.ts";
import { regionDialog, regionMenu } from "./regionState.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import type { QuickPrompt } from "./spawns.ts";
import {
	docked,
	focusedSessionId,
	focusedSubagentId,
	newSessionOpen,
} from "./state.ts";

let pointer: { x: number; y: number } | null = null;

export function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest(
			"input:not([type=checkbox]), textarea, select, [contenteditable]",
		) !== null
	);
}

function focusCovers(): boolean {
	const open =
		focusedSessionId.peek() !== null || focusedSubagentId.peek() !== null;
	if (!open) return false;
	return !docked.peek() || document.activeElement?.closest(".focus") != null;
}

export function blocked(): boolean {
	return (
		focusCovers() ||
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
	const card = useRef<HTMLFormElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const [prompt, setPrompt] = useState("");
	const [images, setImages] = useState<PromptImage[]>([]);
	const [dropping, setDropping] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { k } = view.value;
	const legible = Math.max(1, 1 / k);
	useRestoreFocus();

	useEffect(() => {
		input.current?.focus({ preventScroll: true });
	}, []);

	useLayoutEffect(() => {
		const element = input.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${element.scrollHeight}px`;
	}, [prompt]);

	const cancel = () => {
		if (!busy) quickPrompt.value = null;
	};

	const addImages = async (files: File[]) => {
		const { accepted, error } = admit(images.length, files);
		setError(error);
		const read = await readImages(accepted).catch(() => null);
		if (!read) return setError("Couldn't read that image");
		setImages((held) => [...held, ...read].slice(0, maxPromptImages));
	};

	const submit = async () => {
		const text = prompt.trim();
		if (!text || busy) return;
		setBusy(true);
		setError(null);
		const failure = await spawnFromPrompt(text, images);
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
		} else if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void submit();
		} else if (event.key === "Tab" && open.cwds.length > 1) {
			event.preventDefault();
			const cwd = cycle(open.cwds, open.cwd, event.shiftKey ? -1 : 1);
			if (cwd) quickPrompt.value = { ...open, cwd };
		}
	};

	const carriesFiles = (event: DragEvent) =>
		event.dataTransfer?.types.includes("Files") ?? false;

	const onDragOver = (event: DragEvent) => {
		if (!carriesFiles(event) || busy) return;
		event.preventDefault();
		setDropping(true);
	};

	const onDrop = (event: DragEvent) => {
		if (!carriesFiles(event)) return;
		event.preventDefault();
		setDropping(false);
		if (!busy) void addImages(imageFiles(event.dataTransfer?.files));
		input.current?.focus();
	};

	const onPaste = (event: ClipboardEvent) => {
		const files = imageFiles(event.clipboardData?.files);
		if (files.length === 0) return;
		event.preventDefault();
		void addImages(files);
	};

	const closeIfEmpty = (event: FocusEvent) => {
		const stayed = card.current?.contains(event.relatedTarget as Node | null);
		const empty = !prompt.trim() && images.length === 0;
		if (empty && !stayed && !busy && document.hasFocus())
			quickPrompt.value = null;
	};

	return (
		<form
			ref={card}
			class="quick-prompt"
			aria-label="New session"
			data-no-pan
			style={{
				transform: `translate(${open.at.x}px, ${open.at.y}px) scale(${legible})`,
				width: `min(${sessionSize.w}px, calc((100vw - 32px) / ${legible * k}))`,
			}}
			onDragOver={onDragOver}
			onDragLeave={(event) => {
				if (!card.current?.contains(event.relatedTarget as Node | null))
					setDropping(false);
			}}
			onDrop={onDrop}
		>
			<div
				class={`quick-prompt-field${busy ? " busy" : ""}${dropping ? " dropping" : ""}`}
			>
				<textarea
					ref={input}
					rows={1}
					value={prompt}
					onInput={(event) => setPrompt(event.currentTarget.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onBlur={closeIfEmpty}
					placeholder="What should Claude work on? Shift+Enter for a new line; paste or drop images"
					aria-label="Prompt for a new session"
					disabled={busy}
					spellcheck={false}
					autocomplete="off"
				/>
				{busy && (
					<LoaderCircle size={14} class="focus-spin" aria-hidden="true" />
				)}
				{images.length > 0 && (
					<ul class="quick-prompt-images" aria-label="Attached images">
						{images.map((image, at) => (
							<li key={image.data.slice(-32) + at}>
								<img src={dataUrl(image)} alt={`Attachment ${at + 1}`} />
								<button
									type="button"
									aria-label={`Remove image ${at + 1}`}
									disabled={busy}
									onClick={() => {
										setImages((held) => held.filter((_, i) => i !== at));
										input.current?.focus();
									}}
								>
									<X size={11} aria-hidden="true" />
								</button>
							</li>
						))}
					</ul>
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
		</form>
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
