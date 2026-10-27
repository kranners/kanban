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
	promptHistory,
	type Queued,
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
	const [queued, setQueued] = useState<Queued[]>([]);
	const [problem, setProblem] = useState<string | null>(null);
	const items = view.window.items;
	const lastIndex = items.at(-1)?.index ?? 0;

	const history = useMemo(() => promptHistory(items), [items]);
	const shown = useMemo(
		() => items.filter((item) => item.kind !== "rewound"),
		[items],
	);
	const background = useMemo(() => backgroundTools(items), [items]);

	useEffect(() => {
		setQueued((current) =>
			current.length === 0 ? current : stillQueued(current, items),
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
	}, [view.window, queued, view.dialog]);

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

	const send = async (text: string): Promise<boolean> => {
		setProblem(null);
		const entry = { id: `${Date.now()}`, text, sentAt: Date.now() };
		if (working) setQueued((current) => [...current, entry]);
		pinned.current = true;
		const outcome = await request({ type: "prompt", text });
		if (outcome.ok) return true;
		setQueued((current) => current.filter(({ id }) => id !== entry.id));
		setProblem(outcome.error);
		return false;
	};

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
						{queued.map((entry) => (
							<div key={entry.id} class="av-user av-user-pending">
								<div class="av-user-text">{entry.text}</div>
								<span class="av-queued-label">Queued</span>
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
						onKey={(key) => void press(key)}
					/>
				</div>
			)}
		</div>
	);
}
