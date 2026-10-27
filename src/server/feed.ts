import type { RegionColours } from "../shared/colours.ts";
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
	colours(colours: RegionColours): void;
	exit(sessionId: string, result: ExitResult): void;
	size(): number;
};

export type FeedOptions = {
	board: () => Board;
	previews: () => Preview[];
	layout: () => Layout;
	colours: () => RegionColours;
};

const socketOpen = 1;

export const createFeed = ({
	board,
	previews,
	layout,
	colours,
}: FeedOptions): Feed => {
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
			send(socket, { type: "colours", colours: colours() });
			send(socket, { type: "board", board: board() });
			for (const preview of previews())
				send(socket, { type: "preview", preview });
		},
		board: (next) => broadcast({ type: "board", board: next }),
		preview: (preview) => broadcast({ type: "preview", preview }),
		layout: (next) => broadcast({ type: "layout", layout: next }),
		colours: (next) => broadcast({ type: "colours", colours: next }),
		exit: (sessionId, result) => broadcast({ type: "exit", sessionId, result }),
		size: () => clients.size,
	};
};
