import { Bell, BellOff } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { view } from "./Canvas.tsx";
import { held } from "./exits.ts";
import type { Group } from "./groups.ts";
import {
	ignoreFor,
	ignoreMenu,
	ignoreProject,
	stopIgnoring,
} from "./ignoreState.ts";
import {
	ignoreDurations,
	ignoredUntilLabel,
	quickIgnoreMs,
} from "./ignores.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { now } from "./state.ts";

const menuWidth = 180;
const itemHeight = 32;
const menuChrome = 40;

export function IgnoreButton(props: { group: Group }): JSX.Element {
	const { group } = props;
	const ignore = ignoreFor(group.cwd);
	const quick = held.value.option;
	const open = ignoreMenu.value?.cwd === group.cwd;
	const label = ignore
		? `Stop ignoring ${group.project}, ignored until ${ignoredUntilLabel(ignore.until, now.value)}`
		: quick
			? `Ignore ${group.project} for a day`
			: `Ignore ${group.project}…`;
	const onClick = (event: MouseEvent) => {
		if (ignore) {
			void stopIgnoring(ignore.cwd);
			return;
		}
		if (event.altKey || held.peek().option) {
			void ignoreProject(group.cwd, quickIgnoreMs);
			return;
		}
		if (open) {
			ignoreMenu.value = null;
			return;
		}
		const box = (event.currentTarget as Element).getBoundingClientRect();
		ignoreMenu.value = {
			cwd: group.cwd,
			project: group.project,
			at: { x: box.right - menuWidth, y: box.bottom + 6 },
		};
	};
	return (
		<button
			type="button"
			class={`close-bubble ignore-bubble${ignore ? " ignoring" : ""}`}
			aria-label={label}
			aria-pressed={ignore !== null}
			aria-haspopup={ignore ? undefined : "menu"}
			aria-expanded={ignore ? undefined : open}
			title={
				ignore
					? `Ignored until ${ignoredUntilLabel(ignore.until, now.value)} · click to stop ignoring`
					: "Ignore this project: dim it and silence its notifications · ⌥-click to ignore it for a day"
			}
			data-no-pan
			onClick={onClick}
		>
			{ignore ? (
				<BellOff size={13} strokeWidth={2.25} aria-hidden="true" />
			) : (
				<Bell size={13} strokeWidth={2.25} aria-hidden="true" />
			)}
		</button>
	);
}

export function IgnoreMenu(): JSX.Element | null {
	const menu = ignoreMenu.value;
	const list = useRef<HTMLDivElement>(null);
	useRestoreFocus(menu !== null);

	useEffect(() => {
		if (!menu) return;
		list.current
			?.querySelector<HTMLElement>("[role=menuitem]")
			?.focus({ preventScroll: true });
		const close = () => {
			ignoreMenu.value = null;
		};
		const closeOutside = (event: PointerEvent) => {
			const target = event.target as Element;
			if (list.current?.contains(target)) return;
			if (target.closest?.(".ignore-bubble[aria-expanded='true']")) return;
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

	if (!menu) return null;

	const onKeyDown = (event: KeyboardEvent) => {
		const items = [
			...(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
		];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
		const target =
			event.key === "Home"
				? items[0]
				: event.key === "End"
					? items.at(-1)
					: step === undefined
						? undefined
						: items[(at + step + items.length) % items.length];
		if (!target) return;
		event.preventDefault();
		target.focus();
	};

	const height = ignoreDurations.length * itemHeight + menuChrome;
	return (
		<div
			class="colour-menu ignore-menu"
			role="menu"
			aria-label={`Ignore ${menu.project} for`}
			ref={list}
			style={{
				left: `${Math.max(0, Math.min(menu.at.x, innerWidth - menuWidth))}px`,
				top: `${Math.max(0, Math.min(menu.at.y, innerHeight - height))}px`,
			}}
			onKeyDown={onKeyDown}
			onFocusOut={(event) => {
				const next = event.relatedTarget as Element | null;
				if (!next || list.current?.contains(next)) return;
				ignoreMenu.value = null;
			}}
			onContextMenu={(event) => event.preventDefault()}
		>
			<p class="ignore-menu-title">Ignore for</p>
			{ignoreDurations.map(({ label, ms }) => (
				<button
					key={label}
					type="button"
					role="menuitem"
					tabIndex={-1}
					class="board-menu-item"
					onClick={() => void ignoreProject(menu.cwd, ms)}
				>
					<span class="board-menu-label">{label}</span>
					{ms === quickIgnoreMs && <kbd>⌥-click</kbd>}
				</button>
			))}
		</div>
	);
}
