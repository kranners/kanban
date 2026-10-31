import "./focus/focus.css";
import "./actions.css";
import "./schedules.css";
import {
	CalendarClock,
	CircleAlert,
	LoaderCircle,
	LocateFixed,
	Pencil,
	Play,
	Plus,
	Trash2,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
	defaultReportPrompt,
	defaultScheduleTime,
	maxSchedulePrompt,
} from "../shared/schedules.ts";
import {
	type Point,
	type Schedule,
	type ScheduleMode,
	scheduleModes,
} from "../shared/types.ts";
import { centreOn, view } from "./Canvas.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { commandKey } from "./focus/platform.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import {
	createSchedule,
	deleteSchedule,
	modeLabel,
	type Outcome,
	promptPreview,
	runSchedule,
	scheduleDialog,
	scheduleStatus,
	schedules,
	updateSchedule,
} from "./schedules.ts";
import { annotations, now } from "./state.ts";

type Editing = {
	id: string | null;
	time: string;
	prompt: string;
	mode: ScheduleMode;
	at: Point;
};

const pinSize = { w: 48, h: 48 };

function viewCentre(): Point {
	const stage = document.querySelector(".viewport");
	const v = view.peek();
	const width = stage?.clientWidth ?? innerWidth;
	const height = stage?.clientHeight ?? innerHeight;
	return {
		x: Math.round((width / 2 - v.x) / v.k),
		y: Math.round((height / 2 - v.y) / v.k),
	};
}

const blank = (at: Point): Editing => ({
	id: null,
	time: defaultScheduleTime,
	prompt: defaultReportPrompt,
	mode: "replace",
	at,
});

const editingOf = (schedule: Schedule): Editing => ({
	id: schedule.id,
	time: schedule.time,
	prompt: schedule.prompt,
	mode: schedule.mode,
	at: { x: schedule.x, y: schedule.y },
});

function ErrorNote(props: { error: string }): JSX.Element {
	return (
		<div class="focus-form-error" role="alert">
			<CircleAlert size={16} aria-hidden="true" />
			<p>{props.error}</p>
		</div>
	);
}

function ScheduleRow(props: {
	schedule: Schedule;
	busy: boolean;
	onEdit: () => void;
	onShow: () => void;
	onRun: () => void;
	onDelete: () => void;
}): JSX.Element {
	const { schedule } = props;
	return (
		<li class="schedule-row">
			<div class="schedule-row-main">
				<span class="schedule-time">{schedule.time}</span>
				<span class="schedule-meta focus-muted">
					Every day, Mac time · {modeLabel[schedule.mode].toLowerCase()}
				</span>
				<p class="schedule-prompt">{promptPreview(schedule.prompt)}</p>
				<p class="schedule-status focus-muted">
					{schedule.run && (
						<LoaderCircle size={12} class="focus-spin" aria-hidden="true" />
					)}
					{scheduleStatus(schedule, now.value)}
				</p>
				{schedule.lastError && (
					<p class="schedule-error">
						<CircleAlert size={12} aria-hidden="true" />
						{schedule.lastError}
					</p>
				)}
			</div>
			<div class="schedule-row-actions">
				<button
					type="button"
					class="focus-button focus-icon-button"
					onClick={props.onShow}
					aria-label="Show where it reports"
					title="Show where it reports"
				>
					<LocateFixed size={14} />
				</button>
				<button
					type="button"
					class="focus-button focus-icon-button"
					onClick={props.onRun}
					disabled={props.busy || schedule.run !== null}
					aria-label="Run now"
					title="Run now"
				>
					<Play size={14} />
				</button>
				<button
					type="button"
					class="focus-button focus-icon-button"
					onClick={props.onEdit}
					disabled={props.busy}
					aria-label="Edit"
					title="Edit"
				>
					<Pencil size={14} />
				</button>
				<button
					type="button"
					class="focus-button focus-icon-button"
					onClick={props.onDelete}
					disabled={props.busy}
					aria-label="Delete"
					title="Delete"
				>
					<Trash2 size={14} />
				</button>
			</div>
		</li>
	);
}

function ScheduleForm(props: {
	editing: Editing;
	idPrefix: string;
	onChange: (editing: Editing) => void;
}): JSX.Element {
	const { editing, idPrefix } = props;
	const set = (fields: Partial<Editing>) =>
		props.onChange({ ...editing, ...fields });
	return (
		<div class="schedule-form">
			<label class="focus-field">
				Every day at
				<input
					type="time"
					required
					value={editing.time}
					onInput={(event) => set({ time: event.currentTarget.value })}
				/>
			</label>
			<label class="focus-field">
				Ask the board agent
				<textarea
					id={`${idPrefix}-prompt`}
					rows={5}
					maxLength={maxSchedulePrompt}
					value={editing.prompt}
					onInput={(event) => set({ prompt: event.currentTarget.value })}
				/>
			</label>
			<fieldset class="schedule-modes">
				<legend class="focus-muted">Each new report</legend>
				{scheduleModes.map((mode) => (
					<label key={mode} class="schedule-mode">
						<input
							type="radio"
							name={`${idPrefix}-mode`}
							checked={editing.mode === mode}
							onChange={() => set({ mode })}
						/>
						{modeLabel[mode]}
					</label>
				))}
			</fieldset>
			<p class="focus-muted schedule-hint">
				It runs in this Mac's time zone, once on waking if the Mac slept through
				it, and writes its report as a note
				{editing.id ? " where its pin is" : " at the spot you chose"}.
			</p>
		</div>
	);
}

export function ScheduleDialog(props: { at?: Point }): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const pressedBackdrop = useRef(false);
	const id = useId();
	const [editing, setEditing] = useState<Editing | null>(() =>
		props.at ? blank(props.at) : null,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<Schedule | null>(null);
	const list = schedules.value ?? [];
	useRestoreFocus();

	useEffect(() => {
		dialog.current?.showModal();
	}, []);

	const close = () => {
		if (!busy) scheduleDialog.value = null;
	};

	const act = async <T,>(work: () => Promise<Outcome<T>>) => {
		setBusy(true);
		setError(null);
		const outcome = await work();
		setBusy(false);
		if (!outcome.ok) setError(outcome.error);
		return outcome.ok;
	};

	const save = async () => {
		if (!editing || busy) return;
		const draft = {
			time: editing.time,
			prompt: editing.prompt,
			mode: editing.mode,
		};
		const saved = await act(() =>
			editing.id
				? updateSchedule(editing.id, draft)
				: createSchedule({ ...draft, ...editing.at }),
		);
		if (saved) setEditing(null);
	};

	return (
		<>
			<dialog
				class="focus-dialog schedule-dialog"
				ref={dialog}
				onClose={() => {
					scheduleDialog.value = null;
				}}
				onCancel={(event) => {
					event.preventDefault();
					if (editing && !busy) setEditing(null);
					else close();
				}}
				onPointerDown={(event) => {
					pressedBackdrop.current = event.target === event.currentTarget;
				}}
				onClick={(event) => {
					if (event.target === event.currentTarget && pressedBackdrop.current)
						close();
				}}
				onKeyDown={(event) => {
					if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
						void save();
				}}
				aria-labelledby={`${id}-title`}
			>
				<div class="focus-form">
					<header class="focus-form-header">
						<h2 id={`${id}-title`} class="confirm-title">
							<CalendarClock size={16} aria-hidden="true" />
							{editing
								? editing.id
									? "Edit scheduled report"
									: "New scheduled report"
								: "Scheduled reports"}
						</h2>
						<button
							type="button"
							class="focus-button focus-icon-button"
							onClick={close}
							disabled={busy}
							aria-label="Close"
						>
							<X size={16} />
						</button>
					</header>
					<div class="schedule-body">
						{editing ? (
							<ScheduleForm
								editing={editing}
								idPrefix={id}
								onChange={setEditing}
							/>
						) : list.length === 0 ? (
							<p class="focus-muted">
								No scheduled reports yet. A scheduled report asks the board
								agent the same thing every day, such as what ran overnight, and
								leaves its answer as a note.
							</p>
						) : (
							<ul class="schedule-list">
								{list.map((schedule) => (
									<ScheduleRow
										key={schedule.id}
										schedule={schedule}
										busy={busy}
										onEdit={() => setEditing(editingOf(schedule))}
										onShow={() => {
											scheduleDialog.value = null;
											const note = schedule.noteId
												? annotations.peek()[schedule.noteId]
												: undefined;
											centreOn(
												note ?? { x: schedule.x, y: schedule.y, ...pinSize },
											);
										}}
										onRun={() => void act(() => runSchedule(schedule.id))}
										onDelete={() => setDeleting(schedule)}
									/>
								))}
							</ul>
						)}
						{error && <ErrorNote error={error} />}
					</div>
					<footer class="focus-form-footer">
						<span class="focus-muted focus-form-shortcut">
							{editing && (
								<>
									<kbd>{commandKey}Enter</kbd> to save ·{" "}
								</>
							)}
							<kbd>Esc</kbd> to {editing ? "go back" : "close"}
						</span>
						{editing ? (
							<>
								<button
									type="button"
									class="focus-button"
									disabled={busy}
									onClick={() => setEditing(null)}
								>
									Cancel
								</button>
								<button
									type="button"
									class="focus-button focus-button-primary"
									disabled={
										busy || editing.prompt.trim() === "" || !editing.time
									}
									onClick={() => void save()}
								>
									{busy && (
										<LoaderCircle
											size={14}
											class="focus-spin"
											aria-hidden="true"
										/>
									)}
									Save
								</button>
							</>
						) : (
							<button
								type="button"
								class="focus-button focus-button-primary"
								disabled={busy}
								onClick={() => setEditing(blank(viewCentre()))}
							>
								<Plus size={14} aria-hidden="true" />
								New report
							</button>
						)}
					</footer>
				</div>
			</dialog>
			{deleting && (
				<ConfirmDialog
					title={`Delete the ${deleting.time} report?`}
					confirmLabel="Delete"
					danger
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						const target = deleting;
						setDeleting(null);
						void act(() => deleteSchedule(target.id));
					}}
				>
					<p>It stops running. Notes it already wrote stay on the board.</p>
				</ConfirmDialog>
			)}
		</>
	);
}

export function ScheduleDialogHost(): JSX.Element | null {
	const open = scheduleDialog.value;
	return open ? <ScheduleDialog at={open.at} /> : null;
}
