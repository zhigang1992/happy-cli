import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { join } from "node:path";
import { open, stat } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedMessageKeys = new Set<string>();

    // Track byte offsets per session file for incremental reads
    let sessionOffsets = new Map<string, number>();

    // Track lines that failed to parse (by raw content) so we log them only once
    let failedLineHashes = new Set<string>();

    // Mark existing messages as processed (full read for initial state)
    if (opts.sessionId) {
        let { messages, newOffset } = await readSessionLogIncremental(projectDir, opts.sessionId, 0, failedLineHashes);
        sessionOffsets.set(opts.sessionId, newOffset);
        for (let m of messages) {
            processedMessageKeys.add(messageKey(m));
        }
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {

        // Collect session ids
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            sessions.push(p);
        }
        if (currentSessionId) {
            sessions.push(currentSessionId);
        }

        // Process sessions (incremental — only read new bytes)
        for (let session of sessions) {
            let offset = sessionOffsets.get(session) ?? 0;
            let { messages, newOffset } = await readSessionLogIncremental(projectDir, session, offset, failedLineHashes);
            sessionOffsets.set(session, newOffset);
            for (let msg of messages) {
                let key = messageKey(msg);
                if (processedMessageKeys.has(key)) {
                    continue;
                }
                processedMessageKeys.add(key);
                opts.onMessage(msg);
            }
        }

        // Move pending sessions to finished sessions
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers
        for (let p of sessions) {
            if (!watchers.has(p)) {
                watchers.set(p, startFileWatcher(join(projectDir, `${p}.jsonl`), () => { sync.invalidate(); }));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: (sessionId: string) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

/**
 * Read session log incrementally from a byte offset.
 * Returns only newly parsed messages and the updated byte offset.
 * Failed parse lines are tracked in failedLineHashes to avoid repeated logging.
 */
async function readSessionLogIncremental(
    projectDir: string,
    sessionId: string,
    fromOffset: number,
    failedLineHashes: Set<string>,
): Promise<{ messages: RawJSONLines[]; newOffset: number }> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);

    // Check file size first — skip read entirely if no new bytes
    let fileSize: number;
    try {
        const fileStat = await stat(expectedSessionFile);
        fileSize = fileStat.size;
    } catch {
        return { messages: [], newOffset: fromOffset };
    }

    if (fileSize <= fromOffset) {
        return { messages: [], newOffset: fromOffset };
    }

    // Read only the new bytes
    let newContent: string;
    try {
        const fh = await open(expectedSessionFile, 'r');
        try {
            const buf = Buffer.alloc(fileSize - fromOffset);
            await fh.read(buf, 0, buf.length, fromOffset);
            newContent = buf.toString('utf-8');
        } finally {
            await fh.close();
        }
    } catch {
        return { messages: [], newOffset: fromOffset };
    }

    let messages: RawJSONLines[] = [];
    let lines = newContent.split('\n');
    for (let l of lines) {
        let trimmed = l.trim();
        if (trimmed === '') {
            continue;
        }
        try {
            let message = JSON.parse(trimmed);
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Log failed parse only once per unique line content
                let lineHash = trimmed.slice(0, 200) + ':' + trimmed.length;
                if (!failedLineHashes.has(lineHash)) {
                    failedLineHashes.add(lineHash);
                    logger.debugLargeJson(`[SESSION_SCANNER] Failed to parse message`, message);
                }
                continue;
            }
            messages.push(parsed.data);
        } catch (e) {
            // Log JSON parse errors only once per unique line
            let lineHash = trimmed.slice(0, 200) + ':' + trimmed.length;
            if (!failedLineHashes.has(lineHash)) {
                failedLineHashes.add(lineHash);
                logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            }
            continue;
        }
    }

    return { messages, newOffset: fileSize };
}
