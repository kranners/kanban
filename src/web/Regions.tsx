import "./focus/focus.css";
import "./actions.css";
import "./regions.css";
import {
	CircleAlert,
	Folder,
	LoaderCircle,
	Pencil,
	Trash2,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { Placement, Point, Region } from "../shared/types.ts";
import {
	arrangement,
	cancelPlacement,
	commitPlacement,
	previewPlacement,
	savedPlacement,
} from "./arrangement.ts";
import { view } from "./Canvas.tsx";
import { exitAsk } from "./exits.ts";
import { isAbsoluteDirectory } from "./focus/paths.ts";
import type { Group } from "./groups.ts";
import type { NodeKey } from "./layout.ts";
import type { Rect } from "./placement.ts";
import {
	cancelRegion,
	commitRegion,
	createRegion,
	deleteRegion,
	previewRegion,
	regionDialog,
	regionMenu,
	renameRegion,
} from "./regionState.ts";
import type { RegionHandle } from "./regions.ts";
import {
	arrangedRegion,
	isRegionKey,
	newRegionAt,
	regionEdges,
	storableRegion,
} from "./regions.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { keyboardPoint } from "./Spawning.tsx";
import { boardMenu, quickPrompt } from "./spawns.ts";
import { focusedSessionId, knownCwds, newSessionOpen } from "./state.ts";

const dragThreshold = 4;

type Member = { key: NodeKey; at: Point; size: Partial<Placement> };

type Drag = {
	pointerId: number;
	region: string;
	handle: RegionHandle;
	origin: Rect;
	start: Point;
	rect: Rect;
	members: Member[];
	moved: boolean;
};

let drag: Drag | null = null;
let dragged = false;

function membersOf(group: Group): Member[] {
	const nodes = arrangement.peek()?.nodes;
	return group.members.flatMap((key) => {
		const node = nodes?.get(key);
		if (!node) return [];
		const saved = savedPlacement(key);
		const size =
			saved?.w !== undefined && saved.h !== undefined
				? { w: saved.w, h: saved.h }
				: {};
		return [{ key, at: { x: node.x, y: node.y }, size }];
	});
}

function memberPlacement(member: Member, origin: Rect, rect: Rect): Placement {
	return {
		x: member.at.x + rect.x - origin.x,
		y: member.at.y + rect.y - origin.y,
		...member.size,
	};
}

function setArranging(on: boolean): void {
	document.querySelector(".viewport")?.classList.toggle("arranging", on);
}

function beginDrag(
	event: PointerEvent,
	group: Group,
	handle: RegionHandle,
): void {
	if (event.button !== 0 || !group.region) return;
	(event.currentTarget as Element).setPointerCapture(event.pointerId);
	const origin = storableRegion(group.frame);
	drag = {
		pointerId: event.pointerId,
		region: group.region.id,
		handle,
		origin,
		start: { x: event.clientX, y: event.clientY },
		rect: origin,
		members: handle === "move" ? membersOf(group) : [],
		moved: false,
	};
}

function continueDrag(event: PointerEvent): void {
	if (!drag || event.pointerId !== drag.pointerId) return;
	const dx = event.clientX - drag.start.x;
	const dy = event.clientY - drag.start.y;
	if (!drag.moved && Math.hypot(dx, dy) < dragThreshold) return;
	drag.moved = true;
	setArranging(true);
	const { k } = view.peek();
	drag.rect = arrangedRegion(drag.origin, drag.handle, dx / k, dy / k);
	previewRegion(drag.region, drag.rect);
	for (const member of drag.members)
		previewPlacement(
			member.key,
			memberPlacement(member, drag.origin, drag.rect),
		);
}

function endDrag(event: PointerEvent): void {
	if (!drag || event.pointerId !== drag.pointerId) return;
	const ended = drag;
	drag = null;
	if (!ended.moved) return;
	setArranging(false);
	dragged = true;
	setTimeout(() => {
		dragged = false;
	}, 0);
	if (event.type === "pointercancel") {
		cancelRegion(ended.region);
		for (const member of ended.members) cancelPlacement(member.key);
		return;
	}
	void commitRegion(ended.region, storableRegion(ended.rect));
	for (const member of ended.members)
		void commitPlacement(
			member.key,
			memberPlacement(member, ended.origin, ended.rect),
		);
}

function openMenu(event: MouseEvent, region: Region): void {
	event.preventDefault();
	event.stopPropagation();
	boardMenu.value = null;
	regionMenu.value = { client: { x: event.clientX, y: event.clientY }, region };
}

function gestures(group: Group, handle: RegionHandle) {
	return {
		"data-no-pan": true,
		onPointerDown: (event: PointerEvent) => beginDrag(event, group, handle),
		onPointerMove: continueDrag,
		onPointerUp: endDrag,
		onPointerCancel: endDrag,
		onContextMenu: (event: MouseEvent) =>
			group.region && openMenu(event, group.region),
	};
}

function RegionFrame(props: { group: Group }): JSX.Element | null {
	const { group } = props;
	const region = group.region;
	if (!region) return null;
	return (
		<div
			class="group-frame region-frame"
			data-region={region.id}
			style={{
				transform: `translate(${group.frame.x}px, ${group.frame.y}px)`,
				width: `${group.frame.w}px`,
				height: `${group.frame.h}px`,
			}}
		>
			<button
				type="button"
				class="group-label region-label"
				title={`${region.cwd} · drag to move, click for options`}
				{...gestures(group, "move")}
				onClick={(event) => {
					if (!dragged) openMenu(event, region);
				}}
			>
				<Folder size={12} aria-hidden="true" />
				{group.project}
			</button>
			{regionEdges.map((edge) => (
				<div
					key={edge}
					class="region-edge"
					data-edge={edge}
					aria-hidden="true"
					{...gestures(group, edge)}
				/>
			))}
		</div>
	);
}

export function RegionFrames(props: { groups: readonly Group[] }): JSX.Element {
	return (
		<>
			{props.groups.map((group) =>
				group.region ? <RegionFrame key={group.key} group={group} /> : null,
			)}
		</>
	);
}

function blocked(): boolean {
	return (
		focusedSessionId.peek() !== null ||
		newSessionOpen.peek() ||
		exitAsk.peek() !== null ||
		quickPrompt.peek() !== null ||
		regionDialog.peek() !== null ||
		document.querySelector("dialog[open]") !== null
	);
}

function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("input, textarea, select, [contenteditable]") !== null
	);
}

export function startRegion(): void {
	const at = keyboardPoint();
	if (!at) return;
	boardMenu.value = null;
	regionDialog.value = { mode: "create", at };
}

function RegionMenu(): JSX.Element | null {
	const menu = regionMenu.value;
	const list = useRef<HTMLDivElement>(null);
	useRestoreFocus(menu !== null);

	useEffect(() => {
		if (!menu) return;
		list.current?.querySelector("button")?.focus();
		const close = () => {
			regionMenu.value = null;
		};
		const closeOutside = (event: PointerEvent) => {
			if (!list.current?.contains(event.target as Node)) close();
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
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
	const close = () => {
		regionMenu.value = null;
	};
	return (
		<div
			class="board-menu"
			role="menu"
			ref={list}
			style={{
				left: `${Math.min(menu.client.x, innerWidth - 240)}px`,
				top: `${Math.min(menu.client.y, innerHeight - 92)}px`,
			}}
			onContextMenu={(event) => event.preventDefault()}
		>
			<button
				type="button"
				role="menuitem"
				class="board-menu-item"
				onClick={() => {
					close();
					regionDialog.value = { mode: "rename", region: menu.region };
				}}
			>
				<Pencil size={14} aria-hidden="true" />
				<span class="board-menu-label">Rename</span>
			</button>
			<button
				type="button"
				role="menuitem"
				class="board-menu-item"
				onClick={() => {
					close();
					void deleteRegion(menu.region.id);
				}}
			>
				<Trash2 size={14} aria-hidden="true" />
				<span class="board-menu-label">Delete region</span>
			</button>
		</div>
	);
}

function RegionDialogView(props: {
	open: NonNullable<typeof regionDialog.value>;
}): JSX.Element {
	const { open } = props;
	const dialog = useRef<HTMLDialogElement>(null);
	const first = useRef<HTMLInputElement>(null);
	const pressedBackdrop = useRef(false);
	const id = useId();
	const renaming = open.mode === "rename" ? open.region : null;
	const [cwd, setCwd] = useState("");
	const [name, setName] = useState(renaming?.name ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useRestoreFocus();

	useEffect(() => {
		dialog.current?.showModal();
		first.current?.focus();
		first.current?.select();
	}, []);

	const close = () => {
		if (!busy) regionDialog.value = null;
	};
	const cwdInvalid = cwd !== "" && !isAbsoluteDirectory(cwd);
	const ready = !busy && (renaming !== null || isAbsoluteDirectory(cwd));

	const submit = async (event: Event) => {
		event.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(null);
		const result = renaming
			? await renameRegion(renaming.id, name)
			: open.mode === "create"
				? await createRegion({
						cwd: cwd.trim(),
						...(name.trim() ? { name: name.trim() } : {}),
						...storableRegion(newRegionAt(open.at)),
					})
				: null;
		setBusy(false);
		if (result && !result.ok) setError(result.error);
		else regionDialog.value = null;
	};

	const title = renaming ? "Rename project region" : "New project region";
	return (
		<dialog
			class="focus-dialog"
			ref={dialog}
			onCancel={(event) => {
				if (busy) event.preventDefault();
			}}
			onClose={close}
			onPointerDown={(event) => {
				pressedBackdrop.current = event.target === event.currentTarget;
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && pressedBackdrop.current)
					close();
			}}
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
					void submit(event);
			}}
			aria-labelledby={`${id}-title`}
		>
			<form class="focus-form" onSubmit={submit}>
				<header class="focus-form-header">
					<h2 id={`${id}-title`}>{title}</h2>
					<button
						type="button"
						class="focus-button focus-icon-button"
						onClick={close}
						aria-label="Close"
						disabled={busy}
					>
						<X size={16} />
					</button>
				</header>

				{!renaming && (
					<label class="focus-field">
						<span>Directory</span>
						<input
							type="text"
							ref={first}
							list={`${id}-cwds`}
							value={cwd}
							onInput={(event) => setCwd(event.currentTarget.value)}
							placeholder="/Users/you/dev/project"
							spellcheck={false}
							autocomplete="off"
							aria-invalid={cwdInvalid}
							required
						/>
						<datalist id={`${id}-cwds`}>
							{knownCwds.value.map((option) => (
								<option key={option} value={option} />
							))}
						</datalist>
						{cwdInvalid && (
							<small class="focus-field-hint focus-field-hint-error">
								Use an absolute path starting with /
							</small>
						)}
					</label>
				)}

				<label class="focus-field">
					<span>Name</span>
					<input
						type="text"
						ref={renaming ? first : undefined}
						value={name}
						onInput={(event) => setName(event.currentTarget.value)}
						placeholder="Optional; the directory's name otherwise"
						spellcheck={false}
						autocomplete="off"
						maxLength={60}
					/>
				</label>

				{error && (
					<div class="focus-form-error" role="alert">
						<CircleAlert size={14} />
						<p>{error}</p>
					</div>
				)}

				<footer class="focus-form-footer">
					<button
						type="button"
						class="focus-button"
						onClick={close}
						disabled={busy}
					>
						Cancel
					</button>
					<button
						type="submit"
						class="focus-button focus-button-primary"
						disabled={!ready}
					>
						{busy && <LoaderCircle size={14} class="focus-spin" />}
						{renaming ? "Rename" : "Create region"}
					</button>
				</footer>
			</form>
		</dialog>
	);
}

export function RegionLayer(): JSX.Element {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isRegionKey(event, isTyping(event.target)) || blocked()) return;
			event.preventDefault();
			startRegion();
		};
		addEventListener("keydown", onKeyDown);
		return () => removeEventListener("keydown", onKeyDown);
	}, []);
	const open = regionDialog.value;
	return (
		<>
			<RegionMenu />
			{open && <RegionDialogView open={open} />}
		</>
	);
}
