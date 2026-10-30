import { type Signal, signal } from "@preact/signals";
import { useEffect, useMemo } from "preact/hooks";
import type {
	ConversationClientFrame,
	ConversationServerFrame,
	ConversationStatus,
	Dialog,
	Drive,
} from "../../shared/conversation.ts";
import {
	applyItems,
	connectionDropped,
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

export type Conversation = {
	view: Signal<ConversationView>;
	request(request: Request): Promise<Outcome>;
	loadOlder(): void;
};

type Connected = Conversation & { holders: number; close(): void };

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

const reduce = (
	current: ConversationView,
	frame: Exclude<ConversationServerFrame, { type: "done" }>,
): ConversationView => {
	switch (frame.type) {
		case "items":
			return {
				...current,
				window: applyItems(current.window, frame),
				total: frame.total,
			};
		case "older":
			return {
				...current,
				window: prepend(current.window, frame.first, frame.items),
				loadingOlder: false,
			};
		case "status":
			return { ...current, status: frame.status };
		case "dialog":
			return { ...current, dialog: frame.dialog, answerable: frame.answerable };
		case "mode":
			return { ...current, mode: frame.mode };
		case "drive":
			return { ...current, drive: frame.drive };
		case "ended":
			return { ...current, ended: frame.reason };
	}
};

const connect = (node: ViewNode): Connected => {
	const view = signal(initial());
	const waiting = new Map<string, (outcome: Outcome) => void>();
	let socket: WebSocket | null = null;
	let resume: { epoch: string | null; rev: number } = { epoch: null, rev: 0 };
	let disposed = false;
	let attempt = 0;
	let timer = 0;

	const handle = (frame: ConversationServerFrame) => {
		if (frame.type === "done") {
			const settle = waiting.get(frame.id);
			waiting.delete(frame.id);
			settle?.({ ok: frame.ok, error: frame.error });
			return;
		}
		if (frame.type === "items") resume = { epoch: frame.epoch, rev: frame.rev };
		view.value = reduce(view.value, frame);
	};

	const failPending = () => {
		for (const settle of waiting.values()) {
			settle({ ok: false, error: connectionDropped });
		}
		waiting.clear();
	};

	const open = () => {
		const since = sinceParam(resume.epoch, resume.rev);
		const current = new WebSocket(conversationUrl(location, node, since));
		socket = current;
		current.onopen = () => {
			attempt = 0;
			view.value = { ...view.value, connection: "open" };
		};
		current.onmessage = (event: MessageEvent<string>) =>
			handle(JSON.parse(event.data) as ConversationServerFrame);
		current.onclose = () => {
			if (disposed || socket !== current) return;
			failPending();
			view.value = {
				...view.value,
				connection: "retrying",
				loadingOlder: false,
			};
			const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
			attempt += 1;
			timer = window.setTimeout(open, delay);
		};
	};
	open();

	return {
		view,
		holders: 0,
		request(body) {
			const live = socket;
			if (live?.readyState !== WebSocket.OPEN) {
				return Promise.resolve({ ok: false, error: "Not connected" });
			}
			requestCount += 1;
			const id = `r${requestCount}`;
			return new Promise((resolve) => {
				waiting.set(id, resolve);
				live.send(JSON.stringify({ ...body, id }));
			});
		},
		loadOlder() {
			const { window, loadingOlder } = view.value;
			if (socket?.readyState !== WebSocket.OPEN || window.first <= 0) return;
			if (loadingOlder) return;
			view.value = { ...view.value, loadingOlder: true };
			socket.send(JSON.stringify({ type: "more", before: window.first }));
		},
		close() {
			disposed = true;
			clearTimeout(timer);
			failPending();
			if (socket) {
				socket.onclose = null;
				socket.close();
			}
			socket = null;
		},
	};
};

const connected = new Map<string, Connected>();

export function holdConversation(node: ViewNode): {
	conversation: Conversation;
	release(): void;
} {
	const key = `${node.kind}:${node.id}`;
	const shared = connected.get(key) ?? connect(node);
	connected.set(key, shared);
	shared.holders += 1;
	let released = false;
	return {
		conversation: shared,
		release() {
			if (released) return;
			released = true;
			shared.holders -= 1;
			if (shared.holders > 0) return;
			shared.close();
			connected.delete(key);
		},
	};
}

export function useConversation(node: ViewNode): {
	view: ConversationView;
	request(request: Request): Promise<Outcome>;
	loadOlder(): void;
} {
	const hold = useMemo(() => holdConversation(node), [node.kind, node.id]);
	useEffect(() => hold.release, [hold]);
	const { conversation } = hold;
	return {
		view: conversation.view.value,
		request: conversation.request,
		loadOlder: conversation.loadOlder,
	};
}
