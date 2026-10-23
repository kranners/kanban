import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { RotateCw } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
	AttachClientFrame,
	AttachServerNotice,
} from "../../shared/types.ts";
import { attachUrl } from "./paths.ts";

type Interruption =
	| { kind: "taken-over" }
	| { kind: "exited"; code: number }
	| { kind: "lost" };

const claudeAccent = "#d97757";
const fullReset = "\x1bc";

function accentColour(): string {
	return (
		getComputedStyle(document.documentElement)
			.getPropertyValue("--accent")
			.trim() || claudeAccent
	);
}

function createTerminal(): Terminal {
	const accent = accentColour();
	return new Terminal({
		allowProposedApi: true,
		cursorBlink: true,
		fontFamily: '"JetBrains Mono", ui-monospace, monospace',
		fontSize: 13,
		scrollback: 5000,
		theme: {
			background: "#141413",
			foreground: "#ecebe7",
			cursor: accent,
			cursorAccent: "#141413",
			selectionBackground: "#ecebe733",
		},
	});
}

async function waitForMonoFont(): Promise<void> {
	try {
		await document.fonts.load('13px "JetBrains Mono"');
	} catch {}
}

const interruptionText = {
	"taken-over": "Opened elsewhere",
	exited: "Session detached",
	lost: "Connection lost",
} as const;

export function AttachedTerminal(props: { short: string }): JSX.Element {
	const host = useRef<HTMLDivElement>(null);
	const reattach = useRef<() => void>(() => {});
	const [interruption, setInterruption] = useState<Interruption | null>(null);

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		const term = createTerminal();
		const fit = new FitAddon();
		term.loadAddon(fit);
		let socket: WebSocket | null = null;
		let disposed = false;
		let retryAvailable = true;
		let frame = 0;

		const send = (message: AttachClientFrame) => {
			if (socket?.readyState === WebSocket.OPEN)
				socket.send(JSON.stringify(message));
		};

		const handleNotice = (raw: string, current: WebSocket) => {
			const notice = JSON.parse(raw) as AttachServerNotice;
			current.onclose = null;
			current.close();
			setInterruption(
				notice.t === "taken-over"
					? { kind: "taken-over" }
					: { kind: "exited", code: notice.code },
			);
		};

		const connect = (fresh: boolean) => {
			if (!fresh) term.write(fullReset);
			setInterruption(null);
			const current = new WebSocket(
				attachUrl(location, props.short, term.cols, term.rows),
			);
			current.binaryType = "arraybuffer";
			current.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
				if (typeof event.data === "string") {
					handleNotice(event.data, current);
					return;
				}
				retryAvailable = true;
				term.write(new Uint8Array(event.data));
			};
			current.onclose = () => {
				if (disposed || socket !== current) return;
				if (retryAvailable) {
					retryAvailable = false;
					connect(false);
					return;
				}
				setInterruption({ kind: "lost" });
			};
			socket = current;
		};

		reattach.current = () => {
			retryAvailable = true;
			connect(false);
			term.focus();
		};

		const inputs = [
			term.onData((d) => send({ t: "in", d })),
			term.onBinary((d) => send({ t: "in", d })),
			term.onResize(({ cols, rows }) => send({ t: "resize", cols, rows })),
		];

		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => fit.fit());
		});

		void waitForMonoFont().then(() => {
			if (disposed) return;
			term.open(element);
			fit.fit();
			observer.observe(element);
			connect(true);
			term.focus();
		});

		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			observer.disconnect();
			for (const input of inputs) input.dispose();
			if (socket) {
				socket.onclose = null;
				socket.close();
			}
			term.dispose();
		};
	}, [props.short]);

	return (
		<div class="focus-terminal">
			<div class="focus-terminal-host" ref={host} />
			{interruption && (
				<div class="focus-interruption" role="alert">
					<p>
						{interruptionText[interruption.kind]}
						{interruption.kind === "exited" && interruption.code !== 0 && (
							<span class="focus-muted"> · exit {interruption.code}</span>
						)}
					</p>
					<button
						type="button"
						class="focus-button focus-button-primary"
						onClick={() => reattach.current()}
					>
						<RotateCw size={14} />
						Reattach
					</button>
				</div>
			)}
		</div>
	);
}
