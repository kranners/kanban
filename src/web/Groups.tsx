import "./regions.css";
import { Check, Folder, Pencil, Trash2 } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { type RegionColour, regionColours } from "../shared/colours.ts";
import type { Point } from "../shared/types.ts";
import { cycle } from "./actions.ts";
import { view } from "./Canvas.tsx";
import { colourOf, setRegionColour } from "./colours.ts";
import type { Group } from "./groups.ts";
import { NeedsYouCount, needsYouClass } from "./NeedsYou.tsx";
import { justDragged, projectGestures } from "./projectDrag.ts";
import { deleteRegion, regionDialog, regionMenu } from "./regionState.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { OutstandingSubagentsCount } from "./SubagentPill.tsx";

export function openRegionMenu(group: Group, at: Point): void {
	regionMenu.value =
		regionMenu.peek()?.key === group.key
			? null
			: {
					key: group.key,
					cwd: group.cwd,
					project: group.project,
					at,
					...(group.region ? { region: group.region } : {}),
				};
}

export function belowLabel(label: Element): Point {
	const box = label.getBoundingClientRect();
	return { x: box.left, y: box.bottom + 6 };
}

export function openRegionMenuAtPointer(group: Group, event: MouseEvent): void {
	event.preventDefault();
	event.stopPropagation();
	regionMenu.value = null;
	openRegionMenu(group, { x: event.clientX, y: event.clientY });
}

export function GroupFrames(props: { groups: readonly Group[] }) {
	const open = regionMenu.value?.key;
	return (
		<>
			{props.groups.map((group) => (
				<div
					key={group.key}
					class={`group-frame region region-${colourOf(group.cwd)}${needsYouClass(group.members)}`}
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
						<OutstandingSubagentsCount members={group.members} />
					</button>
				</div>
			))}
		</>
	);
}

const menuWidth = 160;
const swatchesHeight = 90;
const actionsHeight = 80;
const swatchColumns = 4;
const swatchSteps: Record<string, number> = {
	ArrowRight: 1,
	ArrowLeft: -1,
};

function nextItem(
	swatches: HTMLElement[],
	actions: HTMLElement[],
	focused: HTMLElement | null,
	key: string,
): HTMLElement | undefined {
	const items = [...swatches, ...actions];
	if (key === "Home") return items[0];
	if (key === "End") return items.at(-1);
	const swatch = focused ? swatches.indexOf(focused) : -1;
	const action = focused ? actions.indexOf(focused) : -1;
	const down = key === "ArrowDown";
	if (key !== "ArrowDown" && key !== "ArrowUp") {
		const step = swatchSteps[key];
		if (step === undefined || action >= 0) return undefined;
		return cycle(swatches, swatches[swatch] ?? swatches[0], step);
	}
	if (action >= 0) {
		const index = items.indexOf(actions[action] as HTMLElement);
		return items[(index + (down ? 1 : -1) + items.length) % items.length];
	}
	const from = Math.max(swatch, 0);
	const row = from + (down ? swatchColumns : -swatchColumns);
	if (row >= 0 && row < swatches.length) return swatches[row];
	if (actions.length > 0) return down ? actions[0] : actions.at(-1);
	return swatches[(row + swatches.length) % swatches.length];
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
	const { region } = menu;

	const close = () => {
		regionMenu.value = null;
	};
	const choose = (colour: RegionColour) => {
		close();
		void setRegionColour(menu.cwd, colour);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		const within = (selector: string) => [
			...(list.current?.querySelectorAll<HTMLElement>(selector) ?? []),
		];
		const target = nextItem(
			within("[role=menuitemradio]"),
			within("[role=menuitem]"),
			document.activeElement as HTMLElement | null,
			event.key,
		);
		if (!target) return;
		event.preventDefault();
		target.focus();
	};

	const height = swatchesHeight + (region ? actionsHeight : 0);
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
