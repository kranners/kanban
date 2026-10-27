import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
	ConversationClientFrame,
	ConversationServerFrame,
	ConversationStatus,
	Dialog,
	Drive,
} from "../../shared/conversation.ts";
import {
	applyItems,
	emptyWindow,
	prepend,
	sinceParam,
	type Window,
} from "./conversation.ts";
import { conversationUrl } from "./paths.ts";

export type ViewNode = { kind: "session" | "subagent"; id: string };

export type Connection = "connecting" | "open" | "retrying";

export type Outcome = { ok: boolean; error: string | null };

export type Request = ConversationClientFrame extends infer Frame
	? Frame extends { id: string }
		? Omit<Frame, "id">
		: never
	: never;

export type ConversationView = {
	window: Window;
	total: number;
	status: ConversationStatus | null;
	dialog: Dialog | null;
	answerable: boolean;
	mode: string | null;
	drive: Drive | null;
	connection: Connection;
	loadingOlder: boolean;
	ended: string | null;
};

const retryDelays = [500, 1000, 2000, 4000, 8000];

let requestCount = 0;

const initial = (): ConversationView => ({
	window: emptyWindow(),
	total: 0,
	status: null,
	dialog: null,
	answerable: false,
	mode: null,
	drive: null,
	connection: "connecting",
	loadingOlder: false,
	ended: null,
});

export function useConversation(node: ViewNode): {
	view: ConversationView;
	request(request: Request): Promise<Outcome>;
	loadOlder(): void;
} {
	const [view, setView] = useState<ConversationView>(initial);
	const socket = useRef<WebSocket | null>(null);
	const resume = useRef<{ epoch: string | null; rev: number }>({
		epoch: null,
		rev: 0,
	});
	const waiting = useRef(new Map<string, (outcome: Outcome) => void>());
	const first = useRef(0);
	const loading = useRef(false);

	useEffect(() => {
		let disposed = false;
		let attempt = 0;
		let timer = 0;
		resume.current = { epoch: null, rev: 0 };
		setView(initial());

		const handle = (frame: ConversationServerFrame) => {
			switch (frame.type) {
				case "items":
					resume.current = { epoch: frame.epoch, rev: frame.rev };
					setView((current) => {
						const window = applyItems(current.window, frame);
						first.current = window.first;
						return { ...current, window, total: frame.total };
					});
					return;
				case "older":
					loading.current = false;
					setView((current) => {
						const window = prepend(current.window, frame.first, frame.items);
						first.current = window.first;
						return { ...current, window, loadingOlder: false };
					});
					return;
				case "status":
					setView((current) => ({ ...current, status: frame.status }));
					return;
				case "dialog":
					setView((current) => ({
						...current,
						dialog: frame.dialog,
						answerable: frame.answerable,
					}));
					return;
				case "mode":
					setView((current) => ({ ...current, mode: frame.mode }));
					return;
				case "drive":
					setView((current) => ({ ...current, drive: frame.drive }));
					return;
				case "done": {
					const settle = waiting.current.get(frame.id);
					waiting.current.delete(frame.id);
					settle?.({ ok: frame.ok, error: frame.error });
					return;
				}
				case "ended":
					setView((current) => ({ ...current, ended: frame.reason }));
			}
		};

		const failPending = () => {
			for (const settle of waiting.current.values()) {
				settle({ ok: false, error: "The connection dropped" });
			}
			waiting.current.clear();
		};

		const connect = () => {
			const since = sinceParam(resume.current.epoch, resume.current.rev);
			const current = new WebSocket(conversationUrl(location, node, since));
			socket.current = current;
			current.onopen = () => {
				attempt = 0;
				setView((view) => ({ ...view, connection: "open" }));
			};
			current.onmessage = (event: MessageEvent<string>) =>
				handle(JSON.parse(event.data) as ConversationServerFrame);
			current.onclose = () => {
				if (disposed || socket.current !== current) return;
				failPending();
				loading.current = false;
				setView((view) => ({
					...view,
					connection: "retrying",
					loadingOlder: false,
				}));
				const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
				attempt += 1;
				timer = window.setTimeout(connect, delay);
			};
		};
		connect();

		return () => {
			disposed = true;
			clearTimeout(timer);
			failPending();
			if (socket.current) {
				socket.current.onclose = null;
				socket.current.close();
			}
			socket.current = null;
		};
	}, [node.kind, node.id]);

	const request = useCallback((body: Request): Promise<Outcome> => {
		const open = socket.current;
		if (open?.readyState !== WebSocket.OPEN) {
			return Promise.resolve({ ok: false, error: "Not connected" });
		}
		requestCount += 1;
		const id = `r${requestCount}`;
		return new Promise((resolve) => {
			waiting.current.set(id, resolve);
			open.send(JSON.stringify({ ...body, id }));
		});
	}, []);

	const loadOlder = useCallback(() => {
		const open = socket.current;
		if (open?.readyState !== WebSocket.OPEN || first.current <= 0) return;
		if (loading.current) return;
		loading.current = true;
		setView((current) => ({ ...current, loadingOlder: true }));
		open.send(JSON.stringify({ type: "more", before: first.current }));
	}, []);

	return { view, request, loadOlder };
}
