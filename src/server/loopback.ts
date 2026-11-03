import type { IncomingMessage } from "node:http";

const tunnelHeaders = ["cf-connecting-ip", "cf-access-jwt-assertion", "cf-ray"];

/** A request from a process on this Mac, not one that came in through the tunnel. */
export const fromLoopback = (req: IncomingMessage): boolean => {
	const address = req.socket.remoteAddress ?? "";
	const local =
		address === "::1" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(address);
	return (
		local && tunnelHeaders.every((name) => req.headers[name] === undefined)
	);
};
