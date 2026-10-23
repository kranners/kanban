import { execFile } from "node:child_process";
import { promisify } from "node:util";
import serialize from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import type { Board, Preview, Session } from "../shared/types.ts";

export type LogsRunner = (short: string) => Promise<string>;

const run = promisify(execFile);
const previewRows = 24;
const concurrency = 4;

export const claudeLogs =
	(claudeBin: string): LogsRunner =>
	async (short) => {
		const { stdout } = await run(claudeBin, ["logs", short], {
			timeout: 5000,
			maxBuffer: 8 * 1024 * 1024,
		});
		return stdout;
	};

const lastContentLine = (buffer: headless.IBuffer): number => {
	for (let line = buffer.length - 1; line >= 0; line--) {
		if (buffer.getLine(line)?.translateToString(true).trim()) return line;
	}
	return 0;
};

const fragment = (html: string): string => {
	const rows = html.match(/<pre><div[^>]*>([\s\S]*)<\/div><\/pre>/)?.[1] ?? "";
	return `<pre>${rows.replace(/(<span>[^<]*?) +<\/span><\/div>/g, "$1</span></div>")}</pre>`;
};

export const renderPreview = async (ansi: string): Promise<string> => {
	const terminal = new headless.Terminal({
		cols: 200,
		rows: 50,
		scrollback: 1000,
		allowProposedApi: true,
	});
	const serializer = new serialize.SerializeAddon();
	terminal.loadAddon(serializer);
	await new Promise<void>((resolve) => terminal.write(ansi, resolve));
	const buffer = terminal.buffer.active;
	const endLine = lastContentLine(buffer);
	const html = serializer.serializeAsHTML({
		onlySelection: false,
		includeGlobalBackground: false,
		range: {
			startLine: Math.max(0, endLine - previewRows + 1),
			endLine,
			startCol: 0,
		},
	});
	terminal.dispose();
	return fragment(html);
};

export type Previewer = {
	start(): void;
	stop(): void;
	tick(): Promise<void>;
	latest(): Preview[];
};

export type PreviewerOptions = {
	board: () => Board;
	logs: LogsRunner;
	emit: (preview: Preview) => void;
	intervalMs?: number;
	now?: () => number;
};

const previewable = (
	session: Session,
): session is Session & { short: string } =>
	session.kind === "background" && session.short !== null;

export const createPreviewer = ({
	board,
	logs,
	emit,
	intervalMs = 3000,
	now = Date.now,
}: PreviewerOptions): Previewer => {
	const latest = new Map<string, Preview>();
	const capturedVersion = new Map<string, number>();
	let timer: NodeJS.Timeout | null = null;
	let running: Promise<void> | null = null;

	const refresh = async (session: Session & { short: string }) => {
		capturedVersion.set(session.id, session.updatedAt);
		try {
			const html = await renderPreview(await logs(session.short));
			if (timer === null || latest.get(session.id)?.html === html) return;
			const preview = { sessionId: session.id, html, capturedAt: now() };
			latest.set(session.id, preview);
			emit(preview);
		} catch {
			return;
		}
	};

	const pass = async () => {
		const sessions = board().sessions.filter(previewable);
		const known = new Set(sessions.map((session) => session.id));
		for (const id of latest.keys()) if (!known.has(id)) latest.delete(id);
		for (const id of capturedVersion.keys()) {
			if (!known.has(id)) capturedVersion.delete(id);
		}
		const due = sessions.filter(
			(session) =>
				session.activity === "working" ||
				capturedVersion.get(session.id) !== session.updatedAt,
		);
		for (let start = 0; start < due.length; start += concurrency) {
			await Promise.all(due.slice(start, start + concurrency).map(refresh));
		}
	};

	const tick = () => {
		running ??= pass().finally(() => {
			running = null;
		});
		return running;
	};

	return {
		start() {
			if (timer !== null) return;
			timer = setInterval(tick, intervalMs).unref();
			void tick();
		},
		stop() {
			if (timer !== null) clearInterval(timer);
			timer = null;
			latest.clear();
			capturedVersion.clear();
		},
		tick,
		latest: () => [...latest.values()],
	};
};
