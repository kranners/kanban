import "./regions.css";
import {
	Check,
	Folder,
	LogOut,
	Pencil,
	Plus,
	Sticker,
	StickyNote,
	Trash2,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { type RegionColour, regionColours } from "../shared/colours.ts";
import type { Point } from "../shared/types.ts";
import { cycle } from "./actions.ts";
import { addNote, stickerPicker } from "./annotations.ts";
import { groups } from "./arrangement.ts";
import { boardPointAt, view } from "./Canvas.tsx";
import { colourOf, setRegionColour } from "./colours.ts";
import { askToExitProject } from "./exits.ts";
import type { Group } from "./groups.ts";
import { topGroupAt } from "./groups.ts";
import { NeedsYouCount, needsYouClass } from "./NeedsYou.tsx";
import { justDragged, projectGestures } from "./projectDrag.ts";
import { sessionsIn } from "./RegionControls.tsx";
import {
	deleteRegion,
	frontGroup,
	regionDialog,
	regionMenu,
} from "./regionState.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { openQuickPrompt } from "./spawns.ts";

export function groupUnder(event: MouseEvent): Group | null {
	const all = groups.peek();
	const key = (event.target as Element)
		.closest("[data-group]")
		?.getAttribute("data-group");
	const point = boardPointAt(event.clientX, event.clientY);
	return (
		all.find((group) => group.key === key) ??
		(point ? topGroupAt(all, frontGroup.peek(), point) : null)
	);
}

export function openRegionMenu(group: Group, at: Point, board?: Point): void {
	frontGroup.value = group.key;
	regionMenu.value =
		regionMenu.peek()?.key === group.key
			? null
			: {
					key: group.key,
					cwd: group.cwd,
					project: group.project,
					at,
					...(board ? { board } : {}),
					...(group.region ? { region: group.region } : {}),
				};
}

export function belowLabel(label: Element): Point {
	const box = label.getBoundingClientRect();
	return { x: box.left, y: box.bottom + 6 };
}

export function openRegionMenuAtPointer(
	group: Group,
	event: MouseEvent,
	board?: Point,
): void {
	event.preventDefault();
	event.stopPropagation();
	regionMenu.value = null;
	openRegionMenu(group, { x: event.clientX, y: event.clientY }, board);
}

export function GroupFrames(props: { groups: readonly Group[] }) {
	const open = regionMenu.value?.key;
	const front = frontGroup.value;
	return (
		<>
			{props.groups.map((group) => (
				<div
					key={group.key}
					class={`group-frame region region-${colourOf(group.cwd)}${needsYouClass(group.members)}${group.key === front ? " front" : ""}`}
					data-group={group.key}
					style={{
						transform: `translate(${group.frame.x}px, ${group.frame.y}px)`,
						width: `${group.frame.w}px`,
						height: `${group.frame.h}px`,
					}}
				>
					<button
						type="button"
						class="group-label"
						title={`${group.cwd} · drag to move, click for colours`}
						aria-haspopup="menu"
						aria-expanded={open === group.key}
						{...projectGestures(group, "move")}
						onClick={(event) => {
							if (!justDragged())
								openRegionMenu(group, belowLabel(event.currentTarget));
						}}
						onContextMenu={(event) => openRegionMenuAtPointer(group, event)}
					>
						<Folder size={12} aria-hidden="true" />
						<span class="group-label-text">{group.project}</span>
						<NeedsYouCount members={group.members} />
					</button>
				</div>
			))}
		</>
	);
}

const menuWidth = 180;
const swatchesHeight = 90;
const itemHeight = 32;
const separatorHeight = 9;
const swatchColumns = 4;
const swatchSteps: Record<string, number> = {
	ArrowRight: 1,
	ArrowLeft: -1,
};

function nextItem(
	items: HTMLElement[],
	focused: HTMLElement | null,
	key: string,
): HTMLElement | undefined {
	if (key === "Home") return items[0];
	if (key === "End") return items.at(-1);
	const swatches = items.filter((item) => item.role === "menuitemradio");
	const at = focused ? items.indexOf(focused) : -1;
	const swatch = focused ? swatches.indexOf(focused) : -1;
	if (key !== "ArrowDown" && key !== "ArrowUp") {
		const step = swatchSteps[key];
		if (step === undefined || (at >= 0 && swatch < 0)) return undefined;
		return cycle(swatches, swatches[swatch] ?? swatches[0], step);
	}
	const down = key === "ArrowDown";
	const step = down ? 1 : -1;
	const wrap = (index: number) => items[(index + items.length) % items.length];
	if (swatch < 0) return wrap((at < 0 && !down ? 0 : at) + step);
	const row = swatch + (down ? swatchColumns : -swatchColumns);
	if (row >= 0 && row < swatches.length) return swatches[row];
	if (swatches.length === items.length)
		return swatches[(row + swatches.length) % swatches.length];
	const edge = down ? swatches.at(-1) : swatches[0];
	return wrap(items.indexOf(edge as HTMLElement) + step);
}

export function RegionMenu(): JSX.Element | null {
	const menu = regionMenu.value;
	const list = useRef<HTMLDivElement>(null);
	useRestoreFocus(menu !== null);
	const current = menu ? colourOf(menu.cwd) : null;

	useEffect(() => {
		if (!menu) return;
		list.current
			?.querySelector<HTMLElement>('[aria-checked="true"]')
			?.focus({ preventScroll: true });
		const close = () => {
			regionMenu.value = null;
		};
		const closeOutside = (event: PointerEvent) => {
			const target = event.target as Element;
			if (list.current?.contains(target)) return;
			if (event.button === 0 && target.closest?.(".group-label")) return;
			close();
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

	if (!menu || !current) return null;
	const { region, board } = menu;
	const group = groups.value.find((shown) => shown.key === menu.key);
	const sessions = group ? sessionsIn(group) : [];

	const close = () => {
		regionMenu.value = null;
	};
	const choose = (colour: RegionColour) => {
		close();
		void setRegionColour(menu.cwd, colour);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		const items = [
			...(list.current?.querySelectorAll<HTMLElement>(
				"[role=menuitem]:not(:disabled), [role=menuitemradio]",
			) ?? []),
		];
		const target = nextItem(
			items,
			document.activeElement as HTMLElement | null,
			event.key,
		);
		if (!target) return;
		event.preventDefault();
		target.focus();
	};

	const height =
		swatchesHeight +
		(board ? 3 * itemHeight + separatorHeight : 0) +
		(region ? 3 * itemHeight + separatorHeight : 0);
	return (
		<div
			class="colour-menu"
			role="menu"
			aria-label={`Options for ${menu.project}`}
			ref={list}
			style={{
				left: `${Math.max(0, Math.min(menu.at.x, innerWidth - menuWidth))}px`,
				top: `${Math.max(0, Math.min(menu.at.y, innerHeight - height))}px`,
			}}
			onKeyDown={onKeyDown}
			onFocusOut={(event) => {
				const next = event.relatedTarget as Element | null;
				if (!next || list.current?.contains(next)) return;
				if (next.closest?.('.group-label[aria-expanded="true"]')) return;
				close();
			}}
			onContextMenu={(event) => event.preventDefault()}
		>
			{board && (
				<>
					<button
						type="button"
						role="menuitem"
						tabIndex={-1}
						class="board-menu-item"
						onClick={() => {
							close();
							openQuickPrompt(board, group);
						}}
					>
						<Plus size={14} aria-hidden="true" />
						<span class="board-menu-label">New session here</span>
						<kbd>A</kbd>
					</button>
					<button
						type="button"
						role="menuitem"
						tabIndex={-1}
						class="board-menu-item"
						onClick={() => {
							close();
							addNote(board);
						}}
					>
						<StickyNote size={14} aria-hidden="true" />
						<span class="board-menu-label">Add note here</span>
						<kbd>N</kbd>
					</button>
					<button
						type="button"
						role="menuitem"
						tabIndex={-1}
						class="board-menu-item"
						onClick={() => {
							close();
							stickerPicker.value = { client: menu.at, board };
						}}
					>
						<Sticker size={14} aria-hidden="true" />
						<span class="board-menu-label">Add sticker here</span>
						<kbd>S</kbd>
					</button>
					<span class="board-menu-sep" aria-hidden="true" />
				</>
			)}
			<div class="colour-swatches">
				{regionColours.map((colour) => (
					<button
						key={colour}
						type="button"
						role="menuitemradio"
						aria-checked={colour === current}
						aria-label={colour}
						title={colour}
						tabIndex={colour === current ? 0 : -1}
						class={`colour-swatch region region-${colour}`}
						onClick={() => choose(colour)}
					>
						{colour === current && (
							<Check size={14} strokeWidth={3} aria-hidden="true" />
						)}
					</button>
				))}
			</div>
			{region && (
				<>
					<span class="board-menu-sep" aria-hidden="true" />
					<button
						type="button"
						role="menuitem"
						tabIndex={-1}
						class="board-menu-item"
						onClick={() => {
							close();
							regionDialog.value = { mode: "rename", region };
						}}
					>
						<Pencil size={14} aria-hidden="true" />
						<span class="board-menu-label">Rename</span>
					</button>
					<button
						type="button"
						role="menuitem"
						tabIndex={-1}
						class="board-menu-item danger"
						disabled={sessions.length === 0}
						onClick={(event) => {
							close();
							askToExitProject(menu.project, sessions, event.shiftKey);
						}}
					>
						<LogOut size={14} aria-hidden="true" />
						<span class="board-menu-label">Exit every session</span>
					</button>
					<button
						type="button"
						role="menuitem"
						tabIndex={-1}
						class="board-menu-item danger"
						onClick={() => {
							close();
							void deleteRegion(region.id);
						}}
					>
						<Trash2 size={14} aria-hidden="true" />
						<span class="board-menu-label">Delete region</span>
					</button>
				</>
			)}
		</div>
	);
}
