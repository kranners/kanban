import {
	type MirrorClientFrame,
	type MirrorKey,
	type MirrorServerFrame,
	mirrorKeys,
	type Session,
} from "../shared/types.ts";
import type { AttachSocket } from "./attach.ts";
import type { Audit } from "./audit.ts";
import type { Cmux, CmuxResult, CmuxSurface } from "./cmux.ts";

export const maxMirrorText = 16_000;

const socketOpen = 1;

const isMirrorKey = (key: unknown): key is MirrorKey =>
	mirrorKeys.includes(key as MirrorKey);

export const parseMirrorFrame = (raw: unknown): MirrorClientFrame | null => {
	try {
		const frame: unknown = JSON.parse(String(raw));
		if (typeof frame !== "object" || frame === null) return null;
		const { type, text, submit, key } = frame as Record<string, unknown>;
		if (type === "key" && isMirrorKey(key)) return { type, key };
		if (
			type === "text" &&
			typeof text === "string" &&
			typeof submit === "boolean" &&
			text.length <= maxMirrorText &&
			(text.length > 0 || submit)
		) {
			return { type, text, submit };
		}
		return null;
	} catch {
		return null;
	}
};

export type MirrorDeps = {
	cmux: Cmux;
	resolve(session: Session): Promise<CmuxResult<CmuxSurface>>;
	audit: Audit;
	pollMs?: number;
	checkMs?: number;
};

export type MirrorHub = {
	open(socket: AttachSocket, session: Session, identity: string | null): void;
};

type Watch = {
	join(socket: AttachSocket): void;
	leave(socket: AttachSocket): void;
	sent(): void;
};

export const createMirrorHub = (deps: MirrorDeps): MirrorHub => {
	const pollMs = deps.pollMs ?? 500;
	const checkMs = deps.checkMs ?? 5000;
	const watches = new Map<string, Watch>();

	const sendTo = (socket: AttachSocket, frame: MirrorServerFrame) => {
		if (socket.readyState === socketOpen) socket.send(JSON.stringify(frame));
	};

	const watch = (session: Session): Watch => {
		const viewers = new Set<AttachSocket>();
		let target: CmuxSurface | null = null;
		let checkedAt = 0;
		let screen: string | null = null;
		let lastError: string | null = null;
		let timer: NodeJS.Timeout | undefined;

		const broadcast = (frame: MirrorServerFrame) => {
			for (const viewer of viewers) sendTo(viewer, frame);
		};
		const report = (error: string) => {
			if (error === lastError) return;
			lastError = error;
			broadcast({ type: "error", error });
		};
		const stop = () => {
			clearTimeout(timer);
			if (watches.get(session.id) === self) watches.delete(session.id);
		};
		const end = (reason: string) => {
			broadcast({ type: "ended", reason });
			stop();
			for (const viewer of viewers) viewer.close(1000, "ended");
			viewers.clear();
		};
		const stopped = () => viewers.size === 0;

		const tick = async () => {
			if (stopped()) return;
			if (target === null || Date.now() - checkedAt >= checkMs) {
				const resolved = await deps.resolve(session);
				if (stopped()) return;
				if (!resolved.ok) return end(resolved.error);
				target = resolved.value;
				checkedAt = Date.now();
			}
			const read = await deps.cmux.readScreen(target);
			if (stopped()) return;
			if (!read.ok) report(read.error);
			else {
				lastError = null;
				if (read.value !== screen) {
					screen = read.value;
					broadcast({ type: "screen", text: read.value });
				}
			}
			timer = setTimeout(poll, pollMs);
		};
		const poll = () => {
			tick().catch((error: unknown) => {
				console.error("mirror poll failed", error);
				end("The mirror stopped unexpectedly");
			});
		};

		const self: Watch = {
			join(socket) {
				viewers.add(socket);
				if (screen !== null) sendTo(socket, { type: "screen", text: screen });
				if (viewers.size === 1) poll();
			},
			leave(socket) {
				viewers.delete(socket);
				if (stopped()) stop();
			},
			sent() {
				lastError = null;
			},
		};
		watches.set(session.id, self);
		return self;
	};

	const open: MirrorHub["open"] = (socket, session, identity) => {
		let closed = false;
		let sending = Promise.resolve();
		const shared = watches.get(session.id) ?? watch(session);

		const send = (frame: MirrorServerFrame) => {
			if (!closed) sendTo(socket, frame);
		};

		const deliver = async (frame: MirrorClientFrame) => {
			if (closed) return;
			const resolved = await deps.resolve(session);
			const result = !resolved.ok
				? resolved
				: frame.type === "key"
					? await deps.cmux.sendKey(resolved.value, frame.key)
					: frame.text === ""
						? await deps.cmux.sendKey(resolved.value, "Enter")
						: await deps.cmux.paste(resolved.value, frame.text, frame.submit);
			deps.audit({
				action: "mirror-send",
				sessionId: session.id,
				surface: resolved.ok ? resolved.value.surface : null,
				key: frame.type === "key" ? frame.key : null,
				chars: frame.type === "text" ? frame.text.length : null,
				submit: frame.type === "text" && frame.submit,
				identity,
				result: result.ok ? "sent" : `error: ${result.error}`,
			});
			if (result.ok) shared.sent();
			else send({ type: "error", error: result.error });
		};

		deps.audit({ action: "mirror-open", sessionId: session.id, identity });
		socket.on("message", (raw) => {
			const frame = parseMirrorFrame(raw);
			if (!frame) return send({ type: "error", error: "Unsupported input" });
			sending = sending
				.then(() => deliver(frame))
				.catch((error: unknown) => {
					console.error("mirror send failed", error);
					send({ type: "error", error: "Sending failed" });
				});
		});
		socket.on("close", () => {
			closed = true;
			shared.leave(socket);
		});
		shared.join(socket);
	};

	return { open };
};
