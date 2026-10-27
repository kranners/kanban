import type { BoardFeed } from "../shared/types.ts";
import { receiveExit } from "./exits.ts";
import {
	awaitingShort,
	board,
	connection,
	layout,
	openSession,
} from "./state.ts";

const attemptsBeforeLost = 4;

function feedUrl(): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/api/feed`;
}

function receive(frame: BoardFeed): void {
	if (frame.type === "board") {
		board.value = frame.board;
		const short = awaitingShort.value;
		const created = short
			? frame.board.sessions.find((s) => s.short === short)
			: undefined;
		if (created) {
			awaitingShort.value = null;
			openSession(created.id);
		}
		return;
	}
	if (frame.type === "layout") {
		layout.value = frame.layout;
		return;
	}
	receiveExit(frame.sessionId, frame.result);
}

export function connectFeed(): void {
	let attempt = 0;
	const open = () => {
		const socket = new WebSocket(feedUrl());
		socket.addEventListener("open", () => {
			attempt = 0;
			connection.value = "open";
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			try {
				receive(JSON.parse(event.data) as BoardFeed);
			} catch {}
		});
		socket.addEventListener("close", () => {
			connection.value =
				attempt >= attemptsBeforeLost ? "lost" : "reconnecting";
			const delay =
				Math.min(15_000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);
			attempt += 1;
			setTimeout(open, delay);
		});
	};
	open();
}
