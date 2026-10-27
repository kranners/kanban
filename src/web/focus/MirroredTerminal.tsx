import { CircleAlert, RotateCw, SendHorizontal } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type {
	MirrorClientFrame,
	MirrorKey,
	MirrorServerFrame,
} from "../../shared/types.ts";
import { mirrorUrl } from "./paths.ts";

const keyButtons: { key: MirrorKey; label: string }[] = [
	{ key: "Enter", label: "Enter" },
	{ key: "Escape", label: "Esc" },
	{ key: "Tab", label: "Tab" },
	{ key: "Shift+Tab", label: "⇧Tab" },
	{ key: "Up", label: "↑" },
	{ key: "Down", label: "↓" },
	{ key: "Backspace", label: "⌫" },
	{ key: "Ctrl+C", label: "Ctrl+C" },
];

const keysFromEmptyPrompt: Record<string, MirrorKey> = {
	ArrowUp: "Up",
	ArrowDown: "Down",
	Escape: "Escape",
};

const bottomSlackPx = 48;

type Stop = { kind: "ended"; reason: string } | { kind: "lost" };

export function MirroredTerminal(props: { id: string }): JSX.Element {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const socket = useRef<WebSocket | null>(null);
	const prompt = useRef<HTMLTextAreaElement>(null);
	const [connection, setConnection] = useState(0);
	const [screen, setScreen] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [stop, setStop] = useState<Stop | null>(null);
	const [draft, setDraft] = useState("");

	useEffect(() => {
		setStop(null);
		setProblem(null);
		const current = new WebSocket(mirrorUrl(location, props.id));
		current.onmessage = (event: MessageEvent<string>) => {
			const frame = JSON.parse(event.data) as MirrorServerFrame;
			if (frame.type === "screen") setScreen(frame.text);
			if (frame.type === "error") setProblem(frame.error);
			if (frame.type === "ended") {
				current.onclose = null;
				setStop({ kind: "ended", reason: frame.reason });
			}
		};
		current.onclose = () => setStop({ kind: "lost" });
		socket.current = current;
		return () => {
			current.onclose = null;
			current.close();
			socket.current = null;
		};
	}, [props.id, connection]);

	useEffect(() => {
		const frame = requestAnimationFrame(() => prompt.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [screen]);

	const trackPinned = () => {
		const element = scroller.current;
		if (!element) return;
		pinned.current =
			element.scrollHeight - element.scrollTop - element.clientHeight <
			bottomSlackPx;
	};

	const send = (frame: MirrorClientFrame) => {
		if (socket.current?.readyState !== WebSocket.OPEN) return;
		setProblem(null);
		socket.current.send(JSON.stringify(frame));
	};

	const submit = () => {
		send({ type: "text", text: draft, submit: true });
		setDraft("");
	};

	const onPromptKey = (event: KeyboardEvent) => {
		if (event.isComposing) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
			return;
		}
		const key = keysFromEmptyPrompt[event.key];
		if (key && draft === "") {
			event.preventDefault();
			send({ type: "key", key });
		}
	};

	return (
		<div class="focus-mirror">
			<div class="focus-mirror-scroll" ref={scroller} onScroll={trackPinned}>
				<pre class="focus-mirror-screen">
					{screen ?? (stop ? "" : "Reading the cmux pane…")}
				</pre>
			</div>
			{problem && (
				<div class="focus-mirror-problem" role="alert">
					<CircleAlert size={14} />
					<span>{problem}</span>
				</div>
			)}
			<form
				class="focus-mirror-compose"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<div class="focus-mirror-keys" role="toolbar" aria-label="Keys">
					{keyButtons.map(({ key, label }) => (
						<button
							key={key}
							type="button"
							class="focus-button focus-mirror-key"
							title={`Send ${key}`}
							aria-label={`Send ${key}`}
							disabled={stop !== null}
							onClick={() => send({ type: "key", key })}
						>
							{label}
						</button>
					))}
				</div>
				<div class="focus-mirror-prompt">
					<textarea
						ref={prompt}
						rows={2}
						value={draft}
						placeholder="Type to the session. Enter sends, Shift+Enter adds a line. ↑ ↓ Esc go straight through on an empty prompt."
						aria-label="Prompt"
						disabled={stop !== null}
						onInput={(event) => setDraft(event.currentTarget.value)}
						onKeyDown={onPromptKey}
					/>
					<button
						type="submit"
						class="focus-button focus-button-primary"
						disabled={stop !== null}
					>
						<SendHorizontal size={14} />
						Send
					</button>
				</div>
			</form>
			{stop && (
				<div class="focus-interruption" role="alert">
					<p>{stop.kind === "ended" ? stop.reason : "Connection lost"}</p>
					<button
						type="button"
						class="focus-button focus-button-primary"
						onClick={() => setConnection((count) => count + 1)}
					>
						<RotateCw size={14} />
						Reconnect
					</button>
				</div>
			)}
		</div>
	);
}
