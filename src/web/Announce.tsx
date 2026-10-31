import "./focus/focus.css";
import "./actions.css";
import "./permissions.css";
import { Check, CircleAlert, LoaderCircle, Megaphone, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { maxPromptText } from "../shared/conversation.ts";
import { errorOf } from "./exits.ts";
import { commandKey } from "./focus/platform.ts";
import { useRestoreFocus } from "./restoreFocus.ts";
import { board } from "./state.ts";

export type Delivery = {
	id: string;
	name: string;
	ok: boolean;
	error: string | null;
};

type Phase =
	| { kind: "writing"; error?: string }
	| { kind: "sending" }
	| { kind: "sent"; deliveries: Delivery[] };

const commandStart = /^[!/#]/;

export const announceProblem = (text: string): string | null =>
	commandStart.test(text.trimStart())
		? "An announcement cannot start with !, / or #"
		: null;

async function announce(
	text: string,
): Promise<
	{ ok: true; deliveries: Delivery[] } | { ok: false; error: string }
> {
	try {
		const response = await fetch("/api/announce", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!response.ok) return { ok: false, error: await errorOf(response) };
		const body = (await response.json()) as { deliveries: Delivery[] };
		return { ok: true, deliveries: body.deliveries };
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

export function AnnounceDialog(props: { onClose: () => void }): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const pressedBackdrop = useRef(false);
	const id = useId();
	const [text, setText] = useState("");
	const [phase, setPhase] = useState<Phase>({ kind: "writing" });
	useRestoreFocus();

	useEffect(() => {
		dialog.current?.showModal();
		field.current?.focus();
	}, []);

	const live = (board.value?.sessions ?? []).filter(
		(session) =>
			session.activity !== "stopped" && session.activity !== "failed",
	);
	const waiting = live.filter((session) => session.activity === "needs-you");
	const sending = phase.kind === "sending";
	const problem = announceProblem(text);
	const ready = phase.kind === "writing" && text.trim() !== "" && !problem;
	const close = () => {
		if (!sending) props.onClose();
	};

	const send = async () => {
		if (!ready) return;
		setPhase({ kind: "sending" });
		const result = await announce(text);
		setPhase(
			result.ok
				? { kind: "sent", deliveries: result.deliveries }
				: { kind: "writing", error: result.error },
		);
	};

	return (
		<dialog
			class="focus-dialog permission-dialog"
			ref={dialog}
			onClose={props.onClose}
			onCancel={(event) => {
				if (sending) event.preventDefault();
			}}
			onPointerDown={(event) => {
				pressedBackdrop.current = event.target === event.currentTarget;
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && pressedBackdrop.current)
					close();
			}}
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
					event.preventDefault();
					void send();
				}
			}}
			aria-labelledby={`${id}-title`}
		>
			<div class="focus-form">
				<header class="focus-form-header">
					<h2 id={`${id}-title`} class="confirm-title">
						<Megaphone size={16} aria-hidden="true" />
						Announce to every session
					</h2>
					<button
						type="button"
						class="focus-button focus-icon-button"
						onClick={close}
						disabled={sending}
						aria-label="Close"
					>
						<X size={16} />
					</button>
				</header>
				<div class="permission-body">
					{phase.kind === "sent" ? (
						<ul class="announce-results">
							{phase.deliveries.map((delivery) => (
								<li key={delivery.id} class={delivery.ok ? "" : "missed"}>
									{delivery.ok ? (
										<Check size={14} aria-hidden="true" />
									) : (
										<CircleAlert size={14} aria-hidden="true" />
									)}
									<span class="permission-session-name">{delivery.name}</span>
									<span class="focus-muted">
										{delivery.ok ? "Sent" : delivery.error}
									</span>
								</li>
							))}
						</ul>
					) : (
						<>
							<p class="focus-muted">
								Sent right away to {live.length} live session
								{live.length === 1 ? "" : "s"}, even those that are working:
								Claude reads it at its next step.
								{waiting.length > 0 &&
									` ${waiting.length} waiting on a question or permission prompt will be skipped.`}
							</p>
							<label class="focus-field">
								<span>Message</span>
								<textarea
									ref={field}
									value={text}
									maxLength={maxPromptText}
									disabled={sending}
									placeholder="Pull main and rebase before you push."
									onInput={(event) => {
										setText(event.currentTarget.value);
										if (phase.kind === "writing" && phase.error)
											setPhase({ kind: "writing" });
									}}
								/>
							</label>
							{(problem ??
								(phase.kind === "writing" ? phase.error : undefined)) && (
								<div class="focus-form-error" role="alert">
									<CircleAlert size={14} aria-hidden="true" />
									<p>
										{problem ??
											(phase.kind === "writing" ? phase.error : undefined)}
									</p>
								</div>
							)}
						</>
					)}
				</div>
				<footer class="focus-form-footer">
					<span class="focus-muted focus-form-shortcut">
						{phase.kind === "writing" && (
							<>
								<kbd>{commandKey}Enter</kbd> to send ·{" "}
							</>
						)}
						{!sending && (
							<>
								<kbd>Esc</kbd> to close
							</>
						)}
					</span>
					{phase.kind === "sent" ? (
						<button
							type="button"
							class="focus-button focus-button-primary"
							onClick={props.onClose}
						>
							Done
						</button>
					) : (
						<>
							<button
								type="button"
								class="focus-button"
								onClick={close}
								disabled={sending}
							>
								Cancel
							</button>
							<button
								type="button"
								class="focus-button focus-button-primary"
								disabled={!ready || live.length === 0}
								onClick={() => void send()}
							>
								{sending && (
									<LoaderCircle
										size={14}
										class="focus-spin"
										aria-hidden="true"
									/>
								)}
								Send to all
							</button>
						</>
					)}
				</footer>
			</div>
		</dialog>
	);
}
