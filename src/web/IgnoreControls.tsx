import { Bell, BellOff } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Session } from "../shared/types.ts";
import { view } from "./Canvas.tsx";
import { held } from "./exits.ts";
import { directoryName } from "./focus/paths.ts";
import type { Group } from "./groups.ts";
import {
	ignoreFor,
	ignoreMenu,
	ignoreProject,
	stopIgnoring,
} from "./ignoreState.ts";
import {
	type Ignore,
	ignoreDurations,
	ignoredUntilLabel,
	quickIgnoreMs,
} from "./ignores.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { now } from "./state.ts";

const menuWidth = 180;
const itemHeight = 32;
const menuChrome = 40;

function ignoring(ignore: Ignore): string {
	const project = directoryName(ignore.cwd) || ignore.cwd;
	return `${project} is ignored until ${ignoredUntilLabel(ignore.until, now.value)}`;
}

function StopIgnoringButton(props: { ignore: Ignore }): JSX.Element {
	const { ignore } = props;
	return (
		<button
			type="button"
			class="close-bubble ignore-bubble ignoring"
			aria-label={`Stop ignoring: ${ignoring(ignore)}`}
			aria-pressed={true}
			title={`${ignoring(ignore)} · click to stop ignoring it`}
			data-no-pan
			onClick={() => void stopIgnoring(ignore.cwd)}
		>
			<BellOff size={13} strokeWidth={2.25} aria-hidden="true" />
		</button>
	);
}

export function SessionIgnoreButton(props: {
	session: Session;
}): JSX.Element | null {
	const ignore = ignoreFor(props.session.cwd);
	return ignore && <StopIgnoringButton ignore={ignore} />;
}

export function IgnoreButton(props: { group: Group }): JSX.Element {
	const { group } = props;
	const ignore = ignoreFor(group.cwd);
	const quick = held.value.option;
	const open = ignoreMenu.value?.cwd === group.cwd;
	if (ignore) return <StopIgnoringButton ignore={ignore} />;
	const onClick = (event: MouseEvent) => {
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
			class="close-bubble ignore-bubble"
			aria-label={
				quick ? `Ignore ${group.project} for a day` : `Ignore ${group.project}…`
			}
			aria-pressed={false}
			aria-haspopup="menu"
			aria-expanded={open}
			title="Ignore this project: dim it and silence its notifications · ⌥-click to ignore it for a day"
			data-no-pan
			onClick={onClick}
		>
			<Bell size={13} strokeWidth={2.25} aria-hidden="true" />
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
				if (next.closest?.(".ignore-bubble[aria-expanded='true']")) return;
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
