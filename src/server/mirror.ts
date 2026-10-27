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

export const createMirrorHub = (deps: MirrorDeps): MirrorHub => {
	const pollMs = deps.pollMs ?? 500;
	const checkMs = deps.checkMs ?? 5000;

	const open: MirrorHub["open"] = (socket, session, identity) => {
		let closed = false;
		let target: CmuxSurface | null = null;
		let checkedAt = 0;
		let screen: string | null = null;
		let lastError: string | null = null;
		let timer: NodeJS.Timeout | undefined;
		let sending = Promise.resolve();

		const send = (frame: MirrorServerFrame) => {
			if (!closed && socket.readyState === socketOpen) {
				socket.send(JSON.stringify(frame));
			}
		};
		const report = (error: string) => {
			if (error === lastError) return;
			lastError = error;
			send({ type: "error", error });
		};
		const stop = () => {
			closed = true;
			clearTimeout(timer);
		};
		const end = (reason: string) => {
			send({ type: "ended", reason });
			stop();
			socket.close(1000, "ended");
		};

		const tick = async () => {
			if (closed) return;
			if (target === null || Date.now() - checkedAt >= checkMs) {
				const resolved = await deps.resolve(session);
				if (closed) return;
				if (!resolved.ok) return end(resolved.error);
				target = resolved.value;
				checkedAt = Date.now();
			}
			const read = await deps.cmux.readScreen(target);
			if (closed) return;
			if (!read.ok) report(read.error);
			else {
				lastError = null;
				if (read.value !== screen) {
					screen = read.value;
					send({ type: "screen", text: read.value });
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
			if (result.ok) lastError = null;
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
		socket.on("close", stop);
		poll();
	};

	return { open };
};
