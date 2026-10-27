import "./regions.css";
import { signal } from "@preact/signals";
import { Check, Folder } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { type RegionColour, regionColours } from "../shared/colours.ts";
import { cycle } from "./actions.ts";
import { view } from "./Canvas.tsx";
import { colourOf, setRegionColour } from "./colours.ts";
import type { Group } from "./groups.ts";
import { useRestoreFocus } from "./restoreFocus.ts";

type ColourMenu = { cwd: string; project: string; left: number; top: number };

const colourMenu = signal<ColourMenu | null>(null);

function openColourMenu(group: Group, chip: HTMLElement): void {
	const box = chip.getBoundingClientRect();
	colourMenu.value =
		colourMenu.peek()?.cwd === group.cwd
			? null
			: {
					cwd: group.cwd,
					project: group.project,
					left: box.left,
					top: box.bottom + 6,
				};
}

export function GroupFrames(props: { groups: readonly Group[] }) {
	const open = colourMenu.value?.cwd;
	return (
		<>
			{props.groups.map((group) => (
				<div
					key={group.key}
					class={`group-frame region region-${colourOf(group.cwd)}`}
					style={{
						transform: `translate(${group.frame.x}px, ${group.frame.y}px)`,
						width: `${group.frame.w}px`,
						height: `${group.frame.h}px`,
					}}
				>
					<button
						type="button"
						class="group-label"
						data-no-pan
						title={`${group.cwd} · change colour`}
						aria-haspopup="menu"
						aria-expanded={open === group.cwd}
						onClick={(event) => openColourMenu(group, event.currentTarget)}
					>
						<Folder size={12} aria-hidden="true" />
						<span class="group-label-text">{group.project}</span>
					</button>
				</div>
			))}
		</>
	);
}

const menuWidth = 160;
const menuHeight = 90;
const stepKeys: Record<string, number> = {
	ArrowRight: 1,
	ArrowDown: 4,
	ArrowLeft: -1,
	ArrowUp: -4,
};

export function RegionColourMenu(): JSX.Element | null {
	const menu = colourMenu.value;
	const list = useRef<HTMLDivElement>(null);
	useRestoreFocus(menu !== null);
	const current = menu ? colourOf(menu.cwd) : null;

	useEffect(() => {
		if (!menu) return;
		list.current
			?.querySelector<HTMLElement>('[aria-checked="true"]')
			?.focus({ preventScroll: true });
		const close = () => {
			colourMenu.value = null;
		};
		const closeOutside = (event: PointerEvent) => {
			const target = event.target as Element;
			if (list.current?.contains(target)) return;
			if (target.closest?.(".group-label")) return;
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

	const choose = (colour: RegionColour) => {
		colourMenu.value = null;
		void setRegionColour(menu.cwd, colour);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		const swatches = [
			...(list.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ??
				[]),
		];
		const focused = swatches.indexOf(document.activeElement as HTMLElement);
		const step = stepKeys[event.key];
		const target =
			event.key === "Home"
				? swatches[0]
				: event.key === "End"
					? swatches.at(-1)
					: step !== undefined
						? cycle(swatches, swatches[focused] ?? swatches[0], step)
						: undefined;
		if (!target) return;
		event.preventDefault();
		target.focus();
	};

	return (
		<div
			class="colour-menu"
			role="menu"
			aria-label={`Colour for ${menu.project}`}
			ref={list}
			style={{
				left: `${Math.min(menu.left, innerWidth - menuWidth)}px`,
				top: `${Math.min(menu.top, innerHeight - menuHeight)}px`,
			}}
			onKeyDown={onKeyDown}
			onFocusOut={(event) => {
				const next = event.relatedTarget as Node | null;
				if (next && !list.current?.contains(next)) colourMenu.value = null;
			}}
			onContextMenu={(event) => event.preventDefault()}
		>
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
	);
}
