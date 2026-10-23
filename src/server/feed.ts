import type {
	Board,
	BoardFeed,
	ExitResult,
	Layout,
	Preview,
} from "../shared/types.ts";

export type FeedSocket = {
	readonly readyState: number;
	send(data: string): void;
	on(event: "close", listener: () => void): unknown;
};

export type Feed = {
	add(socket: FeedSocket): void;
	board(board: Board): void;
	preview(preview: Preview): void;
	layout(layout: Layout): void;
	exit(sessionId: string, result: ExitResult): void;
	size(): number;
};

export type FeedOptions = {
	board: () => Board;
	previews: () => Preview[];
	layout: () => Layout;
};

const socketOpen = 1;

export const createFeed = ({ board, previews, layout }: FeedOptions): Feed => {
	const clients = new Set<FeedSocket>();

	const send = (socket: FeedSocket, frame: BoardFeed) => {
		if (socket.readyState === socketOpen) socket.send(JSON.stringify(frame));
	};
	const broadcast = (frame: BoardFeed) => {
		const text = JSON.stringify(frame);
		for (const socket of clients) {
			if (socket.readyState === socketOpen) socket.send(text);
		}
	};

	return {
		add(socket) {
			clients.add(socket);
			socket.on("close", () => clients.delete(socket));
			send(socket, { type: "layout", layout: layout() });
			send(socket, { type: "board", board: board() });
			for (const preview of previews())
				send(socket, { type: "preview", preview });
		},
		board: (next) => broadcast({ type: "board", board: next }),
		preview: (preview) => broadcast({ type: "preview", preview }),
		layout: (next) => broadcast({ type: "layout", layout: next }),
		exit: (sessionId, result) => broadcast({ type: "exit", sessionId, result }),
		size: () => clients.size,
	};
};
