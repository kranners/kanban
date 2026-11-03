import { existsSync } from "node:fs";
import { join } from "node:path";

// The board runs headless Claude Code for itself, such as the digests, in
// one working directory under its state. The marker file there lets every
// board server on this Mac leave those runs off the board. The name dates
// from the board agent, which once ran there too, and is kept so boards on
// older code still recognise the directory.
export const agentMarker = ".kanban-board-agent";

export const isAgentDir = (cwd: string): boolean =>
	existsSync(join(cwd, agentMarker));
