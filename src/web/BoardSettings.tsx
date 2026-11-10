import { Settings } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import "./boardSettings.css";
import { autoLayout, setAutoLayout } from "./autoLayoutSetting.ts";
import type { FaceMode } from "./butlerDm.ts";
import { faceSettings, setFaceSettings } from "./butlerFaceSettings.ts";
import {
	type AuthorFilter,
	authorFilter,
	authorKindLabels,
	cardAuthorKinds,
	setAuthorFilter,
} from "./cardFace.ts";
import { setShowSubagents, showSubagents } from "./subagentSetting.ts";

// The board's settings, kept per browser: whether the board lays itself out, whether subagents show, whose cards stand out, and how Butler's DM face shows.

const authorChoices: { filter: AuthorFilter; label: string }[] = [
	{ filter: "all", label: "Every card" },
	...cardAuthorKinds.map((kind) => ({
		filter: kind,
		label: `Only ${authorKindLabels[kind]}'s`,
	})),
];

const faceModes: { mode: FaceMode; label: string; hint: string }[] = [
	{
		mode: "active",
		label: "Show only when active",
		hint: "Up while Butler works on the board or a DM reply arrives, hidden 4 seconds after",
	},
	{ mode: "always", label: "Always show", hint: "Kept on the board" },
	{
		mode: "never",
		label: "Never show",
		hint: "Only the Butler button, unless hidden below",
	},
];

function SettingsPanel(props: { onClose: () => void }): JSX.Element {
	const settings = faceSettings.value;
	const panel = useRef<HTMLDivElement>(null);

	useEffect(() => {
		panel.current
			?.querySelector<HTMLInputElement>("input:checked")
			?.focus({ preventScroll: true });
	}, []);

	return (
		<div
			class="board-settings-panel"
			role="dialog"
			aria-label="Board settings"
			data-no-pan
			ref={panel}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					props.onClose();
				}
			}}
		>
			<fieldset class="board-settings-group">
				<legend>Layout</legend>
				<label class="board-settings-choice">
					<input
						type="checkbox"
						checked={autoLayout.value}
						onChange={(event) => setAutoLayout(event.currentTarget.checked)}
					/>
					<span>
						Auto layout
						<span class="board-settings-hint">
							A trial: the board tidies itself whenever cards come, go or change
							state, and frames the whole board; zoom and scroll stay yours
							until the next tidy
						</span>
					</span>
				</label>
			</fieldset>
			<fieldset class="board-settings-group">
				<legend>Subagents</legend>
				<label class="board-settings-choice">
					<input
						type="checkbox"
						checked={showSubagents.value}
						onChange={(event) => setShowSubagents(event.currentTarget.checked)}
					/>
					<span>
						Show subagents
						<span class="board-settings-hint">
							Subagent cards and chips under every session and Butler card,
							finished ones greyed for an hour
						</span>
					</span>
				</label>
			</fieldset>
			<fieldset class="board-settings-group">
				<legend>Cards by author</legend>
				<p class="board-settings-note">
					Every other author's cards are dimmed in place.
				</p>
				{authorChoices.map((choice) => (
					<label key={choice.filter} class="board-settings-choice">
						<input
							type="radio"
							name="card-author"
							value={choice.filter}
							checked={authorFilter.value === choice.filter}
							onChange={() => setAuthorFilter(choice.filter)}
						/>
						<span>{choice.label}</span>
					</label>
				))}
			</fieldset>
			<fieldset class="board-settings-group">
				<legend>Butler face</legend>
				<p class="board-settings-note">
					Snappy motion: quick moves, no floating.
				</p>
				{faceModes.map((choice) => (
					<label key={choice.mode} class="board-settings-choice">
						<input
							type="radio"
							name="butler-face"
							value={choice.mode}
							checked={settings.mode === choice.mode}
							onChange={() => setFaceSettings({ mode: choice.mode })}
						/>
						<span>
							{choice.label}
							<span class="board-settings-hint">{choice.hint}</span>
						</span>
					</label>
				))}
				<label class="board-settings-choice">
					<input
						type="checkbox"
						checked={settings.hideButton}
						onChange={(event) =>
							setFaceSettings({ hideButton: event.currentTarget.checked })
						}
					/>
					<span>
						Hide the Butler button
						<span class="board-settings-hint">
							The small face in the corner; B still opens the DM
						</span>
					</span>
				</label>
			</fieldset>
		</div>
	);
}

export function BoardSettingsButton(): JSX.Element {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		addEventListener("pointerdown", closeOutside, true);
		return () => removeEventListener("pointerdown", closeOutside, true);
	}, [open]);

	return (
		<div class="board-settings" ref={root}>
			<button
				type="button"
				ref={trigger}
				class="icon-button"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label="Board settings"
				title="Board settings"
				onClick={() => setOpen(!open)}
			>
				<Settings size={16} />
			</button>
			{open && (
				<SettingsPanel
					onClose={() => {
						setOpen(false);
						trigger.current?.focus({ preventScroll: true });
					}}
				/>
			)}
		</div>
	);
}
