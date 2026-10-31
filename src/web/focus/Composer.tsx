import { CornerDownLeft, Square, Zap } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { maxPromptText } from "../../shared/conversation.ts";
import {
	activeToken,
	complete,
	modeLabel,
	type Token,
} from "./conversation.ts";
import { commandsUrl, filesUrl } from "./paths.ts";
import { commandKey } from "./platform.ts";

type Command = { name: string; description: string; source: string };

type Suggestion = { value: string; label: string; detail: string };

const suggestionLimit = 12;

export function Composer(props: {
	sessionId: string;
	history: string[];
	working: boolean;
	disabled: string | null;
	mode: string | null;
	onSend: (text: string, force: boolean) => void;
	recalled: { text: string } | null;
	onRecalled: () => void;
	onEditQueued: (() => void) | null;
	onKey: ((key: "Escape" | "Shift+Tab") => void) | null;
}): JSX.Element {
	const field = useRef<HTMLTextAreaElement>(null);
	const [draft, setDraft] = useState("");
	const [caret, setCaret] = useState(0);
	const [commands, setCommands] = useState<Command[]>([]);
	const [files, setFiles] = useState<string[]>([]);
	const [selected, setSelected] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const recall = useRef<{ at: number; saved: string } | null>(null);

	useEffect(() => {
		let live = true;
		fetch(commandsUrl(props.sessionId))
			.then((response) => (response.ok ? response.json() : []))
			.then((list: Command[]) => {
				if (live) setCommands(list);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [props.sessionId]);

	useEffect(() => {
		const frame = requestAnimationFrame(() => field.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);

	const token: Token | null =
		dismissed === `${draft}:${caret}` ? null : activeToken(draft, caret);
	const mentionQuery = token?.kind === "mention" ? token.query : null;

	useEffect(() => {
		if (mentionQuery === null) return;
		let live = true;
		const timer = setTimeout(() => {
			fetch(filesUrl(props.sessionId, mentionQuery))
				.then((response) => response.json())
				.then((listing: { ok: boolean; files?: string[] }) => {
					if (live) setFiles(listing.ok ? (listing.files ?? []) : []);
				})
				.catch(() => {
					if (live) setFiles([]);
				});
		}, 120);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [mentionQuery, props.sessionId]);

	const suggestions: Suggestion[] = !token
		? []
		: token.kind === "slash"
			? commands
					.filter((command) =>
						command.name.toLowerCase().startsWith(token.query.toLowerCase()),
					)
					.concat(
						commands.filter(
							(command) =>
								!command.name
									.toLowerCase()
									.startsWith(token.query.toLowerCase()) &&
								command.name.toLowerCase().includes(token.query.toLowerCase()),
						),
					)
					.slice(0, suggestionLimit)
					.map((command) => ({
						value: command.name,
						label: `/${command.name}`,
						detail: command.description,
					}))
			: files.slice(0, suggestionLimit).map((file) => ({
					value: file,
					label: file,
					detail: "",
				}));
	const open = suggestions.length > 0;
	const active = Math.min(selected, suggestions.length - 1);

	useLayoutEffect(() => {
		const element = field.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, innerHeight * 0.4)}px`;
	}, [draft]);

	const setValue = (value: string, at: number) => {
		setDraft(value);
		setCaret(at);
		setSelected(0);
		requestAnimationFrame(() => {
			const element = field.current;
			if (!element) return;
			element.value = value;
			element.setSelectionRange(at, at);
		});
	};

	const accept = (suggestion: Suggestion) => {
		if (!token) return;
		const next = complete(draft, caret, token, suggestion.value);
		setValue(next.value, next.caret);
	};

	const submit = (force = false) => {
		if (draft.trim() === "" || props.disabled) return;
		props.onSend(draft, force);
		recall.current = null;
		setValue("", 0);
	};

	useEffect(() => {
		const recalled = props.recalled;
		if (!recalled) return;
		const value =
			draft.trim() === "" ? recalled.text : `${recalled.text}\n${draft}`;
		recall.current = null;
		setValue(value, recalled.text.length);
		field.current?.focus();
		props.onRecalled();
	}, [props.recalled]);

	const browseHistory = (step: -1 | 1): boolean => {
		const history = props.history;
		if (history.length === 0) return false;
		const current = recall.current ?? { at: history.length, saved: draft };
		const at = Math.max(0, Math.min(history.length, current.at + step));
		if (at === current.at) return false;
		recall.current = { at, saved: current.saved };
		const value = at === history.length ? current.saved : (history[at] ?? "");
		setValue(value, step < 0 ? 0 : value.length);
		return true;
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.isComposing) return;
		const element = event.currentTarget as HTMLTextAreaElement;
		if (open) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setSelected((active + step + suggestions.length) % suggestions.length);
				return;
			}
			if (event.key === "Tab" && !event.shiftKey) {
				event.preventDefault();
				const choice = suggestions[active];
				if (choice) accept(choice);
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) {
				const choice = suggestions[active];
				if (
					choice &&
					!(token?.kind === "slash" && choice.value === token.query)
				) {
					event.preventDefault();
					accept(choice);
					return;
				}
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissed(`${draft}:${caret}`);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit(event.ctrlKey || event.metaKey);
			return;
		}
		if (event.key === "Tab" && event.shiftKey && props.onKey) {
			event.preventDefault();
			props.onKey("Shift+Tab");
			return;
		}
		if (event.key === "Escape" && props.working && props.onKey) {
			event.preventDefault();
			props.onKey("Escape");
			return;
		}
		const atStart = element.selectionStart === 0 && element.selectionEnd === 0;
		const atEnd =
			element.selectionStart === element.value.length &&
			element.selectionEnd === element.value.length;
		if (event.key === "ArrowUp" && atStart && props.onEditQueued) {
			event.preventDefault();
			props.onEditQueued();
		} else if (event.key === "ArrowUp" && atStart && browseHistory(-1)) {
			event.preventDefault();
		} else if (
			event.key === "ArrowDown" &&
			atEnd &&
			recall.current &&
			browseHistory(1)
		) {
			event.preventDefault();
		}
	};

	const trackCaret = (event: Event) =>
		setCaret((event.currentTarget as HTMLTextAreaElement).selectionStart);

	const mode = modeLabel(props.mode);
	const { onKey } = props;
	const listId = `av-suggestions-${props.sessionId}`;

	return (
		<div class="av-composer">
			{open && (
				<div
					class="av-suggestions"
					id={listId}
					role="listbox"
					aria-label="Suggestions"
				>
					{suggestions.map((suggestion, at) => (
						<div
							key={suggestion.value}
							id={`${listId}-${at}`}
							role="option"
							tabIndex={-1}
							aria-selected={at === active}
							class={at === active ? "active" : ""}
							onMouseDown={(event) => {
								event.preventDefault();
								accept(suggestion);
							}}
						>
							<span class="av-suggestion-label">{suggestion.label}</span>
							{suggestion.detail && (
								<span class="av-suggestion-detail">{suggestion.detail}</span>
							)}
						</div>
					))}
				</div>
			)}
			<div class="av-input">
				<textarea
					ref={field}
					rows={1}
					value={draft}
					maxLength={maxPromptText}
					placeholder={
						props.disabled ??
						(props.working
							? `Claude is working. Enter queues, ${commandKey}Enter sends now.`
							: "Message Claude. / for commands, @ for files")
					}
					aria-label="Message"
					aria-autocomplete="list"
					aria-controls={open ? listId : undefined}
					aria-activedescendant={open ? `${listId}-${active}` : undefined}
					disabled={props.disabled !== null}
					onInput={(event) => {
						recall.current = null;
						setDraft(event.currentTarget.value);
						setCaret(event.currentTarget.selectionStart);
						setSelected(0);
					}}
					onKeyDown={onKeyDown}
					onKeyUp={trackCaret}
					onClick={trackCaret}
				/>
				<div class="av-input-actions">
					{props.working && onKey && (
						<button
							type="button"
							class="focus-button av-stop"
							onClick={() => onKey("Escape")}
							title="Interrupt (Esc)"
						>
							<Square size={12} aria-hidden="true" />
							Stop
						</button>
					)}
					{props.working && (
						<button
							type="button"
							class="focus-button av-send-now"
							disabled={props.disabled !== null || draft.trim() === ""}
							onClick={() => submit(true)}
							title={`Send now, without waiting for Claude to finish (${commandKey}Enter)`}
						>
							<Zap size={12} aria-hidden="true" />
							Send now
						</button>
					)}
					<button
						type="button"
						class="focus-button focus-button-primary"
						disabled={props.disabled !== null || draft.trim() === ""}
						onClick={() => submit()}
						title={
							props.working
								? "Queue until Claude finishes (Enter)"
								: "Send (Enter)"
						}
					>
						<CornerDownLeft size={14} aria-hidden="true" />
						Send
					</button>
				</div>
			</div>
			<div class="av-composer-foot">
				{onKey && (
					<button
						type="button"
						class="av-mode"
						onClick={() => onKey("Shift+Tab")}
						disabled={props.disabled !== null}
						title="Cycle the permission mode (Shift+Tab)"
					>
						{mode ?? "Permission mode"}
						<kbd>⇧Tab</kbd>
					</button>
				)}
				<span class="av-hint">
					{props.working
						? `Enter queues · ${commandKey}Enter sends now`
						: "Enter sends"}
					{" · Shift+Enter new line · "}
					{props.onEditQueued ? "↑ edits queued" : "↑ history"}
					{onKey && " · Esc interrupts"}
				</span>
			</div>
		</div>
	);
}
