import { signal } from "@preact/signals";
import {
	ArrowDown,
	BookOpen,
	CircleAlert,
	GitBranch,
	LoaderCircle,
} from "lucide-preact";
import type { JSX } from "preact";
import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "preact/hooks";
import type { ConversationStatus } from "../../shared/conversation.ts";
import type { Activity, Session } from "../../shared/types.ts";
import { Composer } from "./Composer.tsx";
import {
	backgroundTools,
	formatElapsed,
	formatTokens,
	modeLabel,
	nextBatch,
	type Outgoing,
	promptHistory,
	stillQueued,
	type ToolItem,
	toolDetail,
} from "./conversation.ts";
import { DialogForm } from "./DialogForm.tsx";
import { type Links, TranscriptItem } from "./Transcript.tsx";
import {
	type Outcome,
	useConversation,
	type ViewNode,
} from "./useConversation.ts";

const bottomSlackPx = 64;
const loadAheadPx = 400;
const echoWaitMs = 8000;

const outboxes = signal<Record<string, Outgoing[]>>({});

const updateOutbox = (
	sessionId: string,
	update: (outbox: Outgoing[]) => Outgoing[],
) => {
	outboxes.value = {
		...outboxes.value,
		[sessionId]: update(outboxes.value[sessionId] ?? []),
	};
};

const queuedLabels: Record<Outgoing["state"], string> = {
	queued: "Queued",
	sending: "Sending…",
	sent: "Sent",
};

function useTicking(active: boolean): number {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

function shortModel(model: string): string {
	return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function StatusBar(props: {
	status: ConversationStatus | null;
	mode: string | null;
	activity: Activity | null;
	cwd: string | null;
	background: ToolItem[];
}) {
	const { status } = props;
	const working = props.activity === "working";
	const now = useTicking(working && status?.turnStartedAt != null);
	const cwd = status?.cwd ?? props.cwd;
	const mode = modeLabel(props.mode ?? status?.permissionMode ?? null);
	const parts: JSX.Element[] = [];
	if (working && status?.turnStartedAt) {
		parts.push(
			<span key="turn" class="av-status-turn num">
				<LoaderCircle size={12} class="focus-spin" aria-hidden="true" />
				{formatElapsed(now - status.turnStartedAt)}
			</span>,
		);
	}
	if (status?.model) {
		parts.push(<span key="model">{shortModel(status.model)}</span>);
	}
	if (cwd) {
		parts.push(
			<span key="cwd" class="av-status-cwd" title={cwd}>
				<bdi>{cwd}</bdi>
			</span>,
		);
	}
	if (status?.branch) {
		parts.push(
			<span
				key="branch"
				class="av-status-branch"
				title={`Branch ${status.branch}`}
			>
				<GitBranch size={12} aria-hidden="true" />
				{status.branch}
			</span>,
		);
	}
	if (mode) parts.push(<span key="mode">{mode}</span>);
	if (props.background.length > 0) {
		parts.push(
			<span
				key="background"
				class="av-status-background num"
				title={props.background
					.map((tool) => `${tool.name}: ${toolDetail(tool)}`)
					.join("\n")}
			>
				<span class="av-running" aria-hidden="true" />
				{props.background.length} in the background
			</span>,
		);
	}
	if (status?.contextTokens) {
		parts.push(
			<span
				key="context"
				class="num"
				title="Tokens in the context window at the last reply"
			>
				{formatTokens(status.contextTokens)} context
			</span>,
		);
	}
	if (status?.outputTokens) {
		parts.push(
			<span
				key="output"
				class="num"
				title="Tokens Claude has written in this transcript"
			>
				{formatTokens(status.outputTokens)} out
			</span>,
		);
	}
	return <div class="av-status">{parts}</div>;
}

export function AgentView(props: {
	node: ViewNode;
	session: Session | null;
	activity: Activity | null;
	onTerminal: (() => void) | null;
	links: Links;
}): JSX.Element {
	const { view, request, loadOlder } = useConversation(props.node);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const previous = useRef({ first: 0, height: 0 });
	const [seen, setSeen] = useState(0);
	const [atBottom, setAtBottom] = useState(true);
	const [problem, setProblem] = useState<string | null>(null);
	const [recalled, setRecalled] = useState<{ text: string } | null>(null);
	const viewed = useRef(props.node.id);
	viewed.current = props.node.id;
	const sessionId = props.node.kind === "session" ? props.node.id : null;
	const outbox = (sessionId && outboxes.value[sessionId]) || [];
	const items = view.window.items;
	const lastIndex = items.at(-1)?.index ?? 0;

	const history = useMemo(() => promptHistory(items), [items]);
	const shown = useMemo(
		() => items.filter((item) => item.kind !== "rewound"),
		[items],
	);
	const background = useMemo(() => backgroundTools(items), [items]);

	useEffect(() => {
		if (!sessionId || !outbox.some((entry) => entry.state === "sent")) return;
		const unechoed = stillQueued(
			outbox.filter((entry) => entry.state === "sent"),
			items,
		);
		updateOutbox(sessionId, (current) =>
			current.filter(
				(entry) => entry.state !== "sent" || unechoed.includes(entry),
			),
		);
	}, [items]);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		if (view.window.first < previous.current.first && !pinned.current) {
			element.scrollTop += element.scrollHeight - previous.current.height;
		} else if (pinned.current) {
			element.scrollTop = element.scrollHeight;
			setSeen(lastIndex);
		}
		previous.current = {
			first: view.window.first,
			height: element.scrollHeight,
		};
	}, [view.window, outbox, view.dialog]);

	useEffect(() => {
		const element = scroller.current;
		const body = element?.firstElementChild;
		if (!element || !body) return;
		const observer = new ResizeObserver(() => {
			if (pinned.current) element.scrollTop = element.scrollHeight;
		});
		observer.observe(body);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const onScroll = () => {
		const element = scroller.current;
		if (!element) return;
		pinned.current =
			element.scrollHeight - element.scrollTop - element.clientHeight <
			bottomSlackPx;
		setAtBottom(pinned.current);
		if (pinned.current) setSeen(lastIndex);
		if (element.scrollTop < loadAheadPx && view.window.first > 0) loadOlder();
	};

	const jump = () => {
		const element = scroller.current;
		if (!element) return;
		pinned.current = true;
		setAtBottom(true);
		element.scrollTop = element.scrollHeight;
		setSeen(lastIndex);
	};

	const drive = view.drive;
	const readOnly =
		props.node.kind === "subagent"
			? "Subagents are read-only."
			: drive?.mode === "read"
				? drive.reason
				: null;
	const working = props.activity === "working";
	const waiting = view.dialog !== null;

	const deliverable =
		sessionId !== null &&
		drive?.mode === "drive" &&
		view.connection === "open" &&
		!working &&
		!waiting;

	useEffect(() => {
		if (!sessionId || !deliverable) return;
		const batch = nextBatch(outbox);
		const head = batch[0];
		if (!head) return;
		const text = batch.map((entry) => entry.text).join("\n");
		const sending: Outgoing = {
			id: head.id,
			text,
			state: "sending",
			sentAt: Date.now(),
		};
		updateOutbox(sessionId, (current) => [
			sending,
			...current.filter((entry) => !batch.includes(entry)),
		]);
		void request({ type: "prompt", text }).then((outcome) => {
			if (outcome.ok) {
				updateOutbox(sessionId, (current) =>
					current.map((entry) =>
						entry.id === sending.id ? { ...entry, state: "sent" } : entry,
					),
				);
				return;
			}
			const shown = viewed.current === sessionId;
			updateOutbox(sessionId, (current) =>
				current.flatMap((entry) =>
					entry.id !== sending.id
						? [entry]
						: shown
							? []
							: [{ ...entry, state: "queued" as const }],
				),
			);
			if (shown) {
				setProblem(outcome.error);
				setRecalled({ text });
			}
		});
	}, [deliverable, outbox]);

	useEffect(() => {
		if (!sessionId) return;
		const sent = outbox.filter((entry) => entry.state === "sent");
		if (sent.length === 0) return;
		const due = Math.min(...sent.map((entry) => entry.sentAt)) + echoWaitMs;
		const timer = setTimeout(
			() =>
				updateOutbox(sessionId, (current) =>
					current.filter(
						(entry) =>
							entry.state !== "sent" || Date.now() - entry.sentAt < echoWaitMs,
					),
				),
			Math.max(0, due - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [outbox]);

	const send = (text: string) => {
		if (!sessionId) return;
		setProblem(null);
		pinned.current = true;
		const now = Date.now();
		updateOutbox(sessionId, (current) => [
			...current,
			{ id: `${now}-${current.length}`, text, state: "queued", sentAt: now },
		]);
	};

	const edit = (ids: string[]) => {
		if (!sessionId) return;
		const picked = outbox.filter(
			(entry) => entry.state === "queued" && ids.includes(entry.id),
		);
		if (picked.length === 0) return;
		updateOutbox(sessionId, (current) =>
			current.filter((entry) => !picked.includes(entry)),
		);
		setRecalled({ text: picked.map((entry) => entry.text).join("\n") });
	};

	const discard = (id: string) => {
		if (!sessionId) return;
		updateOutbox(sessionId, (current) =>
			current.filter((entry) => entry.id !== id || entry.state !== "queued"),
		);
	};

	const queuedIds = outbox
		.filter((entry) => entry.state === "queued")
		.map((entry) => entry.id);

	const press = async (key: "Escape" | "Shift+Tab") => {
		setProblem(null);
		const outcome: Outcome = await request({ type: "key", key });
		if (!outcome.ok) setProblem(outcome.error);
	};

	const unseen = Math.max(0, lastIndex - seen);
	const loading = view.connection === "connecting" && items.length === 0;

	return (
		<div class="av">
			<StatusBar
				status={view.status}
				mode={view.mode}
				activity={props.activity}
				cwd={props.session?.cwd ?? null}
				background={background}
			/>
			{readOnly && props.node.kind === "session" && (
				<div class="focus-callout">
					<BookOpen size={14} aria-hidden="true" />
					<span>{readOnly}</span>
				</div>
			)}
			<div class="av-stage">
				<div class="av-scroll" ref={scroller} onScroll={onScroll}>
					<div class="av-body">
						{view.window.first > 0 && (
							<button
								type="button"
								class="av-older"
								onClick={loadOlder}
								disabled={view.loadingOlder}
							>
								{view.loadingOlder
									? "Loading earlier messages…"
									: `Load earlier messages (${view.window.first} more)`}
							</button>
						)}
						{shown.map((item) => (
							<div key={item.index} class="av-item">
								<TranscriptItem item={item} links={props.links} />
							</div>
						))}
						{outbox.map((entry) => (
							<div key={entry.id} class="av-user av-user-pending">
								<div class="av-user-text">{entry.text}</div>
								<div class="av-queued-foot">
									<span class="av-queued-label">
										{queuedLabels[entry.state]}
									</span>
									{entry.state === "queued" && (
										<>
											<button
												type="button"
												class="av-queued-action"
												onClick={() => edit([entry.id])}
												title="Move back into the message box to edit"
											>
												Edit
											</button>
											<button
												type="button"
												class="av-queued-action"
												onClick={() => discard(entry.id)}
											>
												Remove
											</button>
										</>
									)}
								</div>
							</div>
						))}
						{working && !view.dialog && (
							<div class="av-working" role="status">
								<span class="av-running" aria-hidden="true" />
								Working…
							</div>
						)}
						{loading && (
							<p class="focus-muted av-empty">Loading the conversation…</p>
						)}
						{!loading && items.length === 0 && view.window.first === 0 && (
							<p class="focus-muted av-empty">
								Nothing in this conversation yet.
							</p>
						)}
					</div>
				</div>
				{!atBottom && (
					<button type="button" class="av-jump" onClick={jump}>
						<ArrowDown size={14} aria-hidden="true" />
						{unseen > 0 ? `Jump to latest · ${unseen} new` : "Jump to latest"}
					</button>
				)}
			</div>
			{view.connection === "retrying" && (
				<div class="av-banner" role="status">
					<LoaderCircle size={13} class="focus-spin" aria-hidden="true" />
					Reconnecting…
				</div>
			)}
			{view.dialog && (
				<DialogForm
					dialog={view.dialog}
					answerable={view.answerable}
					readOnly={readOnly}
					items={items}
					onRequest={request}
					onTerminal={props.onTerminal}
				/>
			)}
			{problem && (
				<div class="focus-mirror-problem" role="alert">
					<CircleAlert size={14} aria-hidden="true" />
					<span>{problem}</span>
				</div>
			)}
			{props.node.kind === "session" && readOnly === null && (
				<div class="av-composer-slot" hidden={view.dialog !== null}>
					<Composer
						sessionId={props.node.id}
						history={history}
						working={working}
						disabled={
							drive === null
								? "Connecting…"
								: waiting
									? "Answer the prompt above first"
									: null
						}
						mode={view.mode ?? view.status?.permissionMode ?? null}
						onSend={send}
						recalled={recalled}
						onEditQueued={queuedIds.length > 0 ? () => edit(queuedIds) : null}
						onKey={(key) => void press(key)}
					/>
				</div>
			)}
		</div>
	);
}
