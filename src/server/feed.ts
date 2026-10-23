import type { Board, BoardFeed, Preview } from "../shared/types.ts";

export type FeedSocket = {
	readonly readyState: number;
	send(data: string): void;
	on(event: "close", listener: () => void): unknown;
};

export type Feed = {
	add(socket: FeedSocket): void;
	board(board: Board): void;
	preview(preview: Preview): void;
	size(): number;
};

export type FeedOptions = {
	board: () => Board;
	previews: () => Preview[];
};

const socketOpen = 1;

export const createFeed = ({ board, previews }: FeedOptions): Feed => {
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
			send(socket, { type: "board", board: board() });
			for (const preview of previews())
				send(socket, { type: "preview", preview });
		},
		board: (next) => broadcast({ type: "board", board: next }),
		preview: (preview) => broadcast({ type: "preview", preview }),
		size: () => clients.size,
	};
};
