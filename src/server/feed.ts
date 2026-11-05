import type { RegionColours } from "../shared/colours.ts";
import type { ProjectIgnores } from "../shared/ignores.ts";
import type { BoardNotification } from "../shared/notifications.ts";
import type { RunnerView } from "../shared/runners.ts";
import type {
	Annotations,
	Board,
	BoardFeed,
	ButlerPresence,
	CommentThread,
	Digests,
	DocIndex,
	DocStore,
	ExitResult,
	LastRuns,
	Layout,
	Region,
	Relation,
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
	lastRuns(lastRuns: LastRuns): void;
	ignores(ignores: ProjectIgnores): void;
	notifications(notifications: BoardNotification[]): void;
	regions(regions: Region[]): void;
	exit(sessionId: string, result: ExitResult): void;
	report(sessionId: string, result: ReportResult): void;
	regionReport(regionId: string, result: ReportResult): void;
	comments(comments: CommentThread[]): void;
	comment(comment: CommentThread): void;
	usage(usage: Usage): void;
	digests(digests: Digests): void;
	relations(relations: Relation[]): void;
	docs(): void;
	butler(butler: ButlerPresence): void;
	runners(runners: RunnerView[]): void;
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
	relations: () => Relation[];
	docs: () => DocIndex;
	docStores: () => DocStore[];
	butler?: () => ButlerPresence;
	runners?: () => RunnerView[];
	lastRuns?: () => LastRuns;
	notifications?: () => BoardNotification[];
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
	relations,
	docs,
	docStores,
	butler,
	runners,
	lastRuns,
	notifications,
}: FeedOptions): Feed => {
	const clients = new Set<FeedSocket>();

	const docsFrame = (): BoardFeed => ({
		type: "docs",
		docs: docs(),
		stores: docStores(),
	});

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
			if (lastRuns) send(socket, { type: "last-runs", lastRuns: lastRuns() });
			send(socket, { type: "ignores", ignores: ignores() });
			if (notifications)
				send(socket, {
					type: "notifications",
					notifications: notifications(),
				});
			send(socket, { type: "regions", regions: regions() });
			send(socket, { type: "comments", comments: comments() });
			send(socket, { type: "usage", usage: usage() });
			send(socket, { type: "digests", digests: digests() });
			send(socket, { type: "relations", relations: relations() });
			send(socket, docsFrame());
			if (butler) send(socket, { type: "butler", butler: butler() });
			if (runners) send(socket, { type: "runners", runners: runners() });
			send(socket, { type: "board", board: board() });
		},
		board: (next) => broadcast({ type: "board", board: next }),
		layout: (next) => broadcast({ type: "layout", layout: next }),
		annotations: (next) =>
			broadcast({ type: "annotations", annotations: next }),
		colours: (next) => broadcast({ type: "colours", colours: next }),
		lastRuns: (next) => broadcast({ type: "last-runs", lastRuns: next }),
		ignores: (next) => broadcast({ type: "ignores", ignores: next }),
		notifications: (next) =>
			broadcast({ type: "notifications", notifications: next }),
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
		relations: (next) => broadcast({ type: "relations", relations: next }),
		docs: () => broadcast(docsFrame()),
		butler: (next) => broadcast({ type: "butler", butler: next }),
		runners: (next) => broadcast({ type: "runners", runners: next }),
		size: () => clients.size,
	};
};
