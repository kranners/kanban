import "./focus/focus.css";
import "./butler.css";
import { X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { jobComposerOpen, startJob } from "./butlerThreads.ts";
import { visibleBoard } from "./Comments.tsx";
import { useRestoreFocus } from "./restoreFocus.ts";

/** A small composer for a Butler job: a task he does end to end in its own thread. */
function JobComposer(props: { onClose: () => void }): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	useRestoreFocus();

	useEffect(() => {
		dialog.current?.showModal();
		input.current?.focus();
	}, []);

	const start = async () => {
		const task = text.trim();
		if (!task || sending) return;
		setSending(true);
		const started = await startJob(task, visibleBoard());
		setSending(false);
		if (!started.ok) {
			setError(started.error);
			return;
		}
		props.onClose();
	};

	return (
		<dialog
			class="focus-dialog butler-job-dialog"
			ref={dialog}
			onClose={props.onClose}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					props.onClose();
				}
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) props.onClose();
			}}
			aria-labelledby="butler-job-title"
		>
			<form
				class="focus-form"
				onSubmit={(event) => {
					event.preventDefault();
					void start();
				}}
			>
				<header class="focus-form-header">
					<h2 id="butler-job-title" class="confirm-title">
						New Butler job
					</h2>
					<button
						type="button"
						class="focus-button focus-icon-button"
						onClick={props.onClose}
						aria-label="Close"
					>
						<X size={16} />
					</button>
				</header>
				<div class="confirm-body">
					<textarea
						ref={input}
						class="comment-input butler-job-input"
						rows={4}
						value={text}
						maxLength={4000}
						placeholder="What should Butler do? He does it in its own thread and reports back."
						aria-label="The job for Butler"
						onInput={(event) => {
							setText(event.currentTarget.value);
							setError(null);
						}}
						onKeyDown={(event) => {
							if (event.isComposing) return;
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void start();
							}
						}}
					/>
					{error && (
						<p class="comment-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<footer class="focus-form-footer">
					<span class="focus-muted focus-form-shortcut">
						<kbd>⌘ Enter</kbd> to start · <kbd>Esc</kbd> to cancel
					</span>
					<button
						type="submit"
						class="focus-button focus-button-primary"
						disabled={!text.trim() || sending}
					>
						Start
					</button>
				</footer>
			</form>
		</dialog>
	);
}

export function JobComposerHost(): JSX.Element | null {
	if (!jobComposerOpen.value) return null;
	return (
		<JobComposer
			onClose={() => {
				jobComposerOpen.value = false;
			}}
		/>
	);
}
