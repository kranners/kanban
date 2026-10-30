import type { RegionColours } from "../shared/colours.ts";
import type { ProjectIgnores } from "../shared/ignores.ts";
import type {
	Annotations,
	Board,
	BoardFeed,
	CommentThread,
	Digests,
	ExitResult,
	Layout,
	Region,
	ReportResult,
	Usage,
} from "../shared/types.ts";

export type FeedSocket = {
	readonly readyState: number;
	send(data: string): void;
	on(event: "close", listener: () => void): unknown;
};

export type Feed = {
	add(socket: FeedSocket): void;
	board(board: Board): void;
	layout(layout: Layout): void;
	annotations(annotations: Annotations): void;
	colours(colours: RegionColours): void;
	ignores(ignores: ProjectIgnores): void;
	regions(regions: Region[]): void;
	exit(sessionId: string, result: ExitResult): void;
	report(sessionId: string, result: ReportResult): void;
	regionReport(regionId: string, result: ReportResult): void;
	comments(comments: CommentThread[]): void;
	comment(comment: CommentThread): void;
	usage(usage: Usage): void;
	digests(digests: Digests): void;
	size(): number;
};

export type FeedOptions = {
	board: () => Board;
	layout: () => Layout;
	annotations: () => Annotations;
	colours: () => RegionColours;
	ignores: () => ProjectIgnores;
	regions: () => Region[];
	comments: () => CommentThread[];
	usage: () => Usage;
	digests: () => Digests;
};

const socketOpen = 1;

export const createFeed = ({
	board,
	layout,
	annotations,
	colours,
	ignores,
	regions,
	comments,
	usage,
	digests,
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
			send(socket, { type: "annotations", annotations: annotations() });
			send(socket, { type: "colours", colours: colours() });
			send(socket, { type: "ignores", ignores: ignores() });
			send(socket, { type: "regions", regions: regions() });
			send(socket, { type: "comments", comments: comments() });
			send(socket, { type: "usage", usage: usage() });
			send(socket, { type: "digests", digests: digests() });
			send(socket, { type: "board", board: board() });
		},
		board: (next) => broadcast({ type: "board", board: next }),
		layout: (next) => broadcast({ type: "layout", layout: next }),
		annotations: (next) =>
			broadcast({ type: "annotations", annotations: next }),
		colours: (next) => broadcast({ type: "colours", colours: next }),
		ignores: (next) => broadcast({ type: "ignores", ignores: next }),
		regions: (next) => broadcast({ type: "regions", regions: next }),
		exit: (sessionId, result) => broadcast({ type: "exit", sessionId, result }),
		report: (sessionId, result) =>
			broadcast({ type: "report", sessionId, result }),
		regionReport: (regionId, result) =>
			broadcast({ type: "region-report", regionId, result }),
		comments: (next) => broadcast({ type: "comments", comments: next }),
		comment: (comment) => broadcast({ type: "comment", comment }),
		usage: (next) => broadcast({ type: "usage", usage: next }),
		digests: (next) => broadcast({ type: "digests", digests: next }),
		size: () => clients.size,
	};
};
