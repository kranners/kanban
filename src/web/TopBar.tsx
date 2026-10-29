import {
	LoaderCircle,
	Moon,
	Plus,
	RotateCw,
	Search,
	Sun,
	SunMoon,
	WandSparkles,
} from "lucide-preact";
import { useState } from "preact/hooks";
import { activityOrder } from "../shared/types.ts";
import { NotifyToggle } from "./Alerts.tsx";
import { ActivityIcon, activityLabel } from "./activity.tsx";
import { tidyBoard, tidying } from "./Comments.tsx";
import { Mark } from "./Mark.tsx";
import { NextNeedingYou } from "./NeedsYou.tsx";
import { SubagentPill } from "./SubagentPill.tsx";
import {
	activityCounts,
	activityFilter,
	connection,
	newSessionOpen,
	search,
	toggleActivity,
} from "./state.ts";
import { cycleTheme, theme } from "./theme.ts";
import { UsagePill } from "./UsagePill.tsx";

const themeIcon = { system: SunMoon, light: Sun, dark: Moon };
const themeName = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
};

function TidyButton() {
	const [error, setError] = useState<string | null>(null);
	const busy = tidying.value;
	const label = busy ? "Tidying the board" : "Tidy the board";
	return (
		<button
			type="button"
			class="icon-button"
			disabled={busy}
			onClick={async () => {
				const started = await tidyBoard();
				setError(started.ok ? null : started.error);
			}}
			aria-label={label}
			title={error ?? `${label} with the board agent`}
		>
			{busy ? (
				<LoaderCircle size={16} class="spin" />
			) : (
				<WandSparkles size={16} />
			)}
		</button>
	);
}

export function TopBar() {
	const ThemeIcon = themeIcon[theme.value];
	const counts = activityCounts.value;
	return (
		<header class="topbar">
			<div class="brand">
				<Mark />
				<span class="wordmark">kanban</span>
				<span class="host">{location.hostname || "local"}</span>
				{connection.value === "reconnecting" && (
					<span class="reconnecting" role="status">
						<span class="pulse" />
						Reconnecting
					</span>
				)}
				{connection.value === "lost" && (
					<button
						type="button"
						class="reconnecting"
						onClick={() => location.reload()}
						title="The board lost its connection; reload to sign in again"
					>
						<RotateCw size={12} />
						Reload
					</button>
				)}
			</div>
			<fieldset class="pills" aria-label="Filter by activity">
				{activityOrder
					.filter((a) => (counts.get(a) ?? 0) > 0)
					.map((a) => (
						<button
							key={a}
							type="button"
							class={`pill act-${a}`}
							aria-pressed={activityFilter.value.has(a)}
							title={`Show only ${activityLabel[a].toLowerCase()}`}
							onClick={() => toggleActivity(a)}
						>
							<ActivityIcon activity={a} size={11} />
							<span class="pill-label">{activityLabel[a]}</span>
							<span class="num">{counts.get(a)}</span>
						</button>
					))}
				<SubagentPill />
			</fieldset>
			<div class="actions">
				<UsagePill />
				<NextNeedingYou />
				<label class="search">
					<Search size={14} aria-hidden="true" />
					<input
						type="search"
						placeholder="Search sessions"
						value={search.value}
						onInput={(event) => {
							search.value = event.currentTarget.value;
						}}
						aria-label="Search sessions"
					/>
				</label>
				<TidyButton />
				<NotifyToggle />
				<button
					type="button"
					class="icon-button"
					onClick={cycleTheme}
					aria-label={themeName[theme.value]}
					title={themeName[theme.value]}
				>
					<ThemeIcon size={16} />
				</button>
				<button
					type="button"
					class="primary"
					onClick={() => {
						newSessionOpen.value = true;
					}}
				>
					<Plus size={16} strokeWidth={2.25} />
					<span class="primary-label">New session</span>
				</button>
			</div>
		</header>
	);
}
