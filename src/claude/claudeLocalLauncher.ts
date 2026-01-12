import { logger } from "@/ui/logger";
import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
            // Block SDK summary messages - we generate our own
            if (message.type !== 'summary') {
                session.client.sendClaudeSessionMessage(message)
            }
        }
    });

    // Register callback to notify scanner when session ID is found via hook
    // This is important for --continue/--resume where session ID is not known upfront
    const scannerSessionCallback = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(scannerSessionCallback);


    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortRequested = false; // Track if abort was requested (vs normal exit)
    let processAbortController = new AbortController();
    let exutFuture = new Future<void>();
    try {
        // Wrapper functions that capture current controller/future via closure
        function getAbortController() { return processAbortController; }
        function getExitFuture() { return exutFuture; }

        async function abort() {
            // Send abort signal using current controller
            const controller = getAbortController();
            const exitFuture = getExitFuture();

            if (!controller.signal.aborted) {
                controller.abort();
            }

            // Await full exit
            await exitFuture.promise;
        }

        async function doAbort() {
            logger.debug('[local]: doAbort');

            // Abort current operation without switching modes
            // This allows the user to abort the current command and continue in local mode
            abortRequested = true;

            // Reset sent messages
            session.queue.reset();

            // Abort
            await abort();
        }

        async function doSwitch() {
            logger.debug('[local]: doSwitch');

            // Switching to remote mode
            if (!exitReason) {
                exitReason = 'switch';
            }

            // Abort
            await abort();
        }

        // When to abort
        session.client.rpcHandlerManager.registerHandler('abort', doAbort); // Abort current process without switching modes
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When user wants to switch to remote mode
        session.queue.setOnMessage((message: string, mode) => {
            // Switch to remote mode when message received
            doSwitch();
        }); // When any message is received, abort current process, clean queue and switch to remote mode

        // Exit if there are messages in the queue
        if (session.queue.size() > 0) {
            return 'switch';
        }

        // Handle session start
        const handleSessionStart = (sessionId: string) => {
            session.onSessionFound(sessionId);
            scanner.onNewSession(sessionId);
        }

        // Run local mode
        while (true) {
            // If we already have an exit reason, return it
            if (exitReason) {
                return exitReason;
            }

            // Launch
            logger.debug('[local]: launch');
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    onSessionFound: handleSessionStart,
                    onThinkingChange: session.onThinkingChange,
                    abort: processAbortController.signal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.hookSettingsPath,
                });

                // Consume one-time Claude flags after spawn
                // For example we don't want to pass --resume flag after first spawn
                session.consumeOneTimeFlags();

                // Check if abort was requested (via RPC) vs normal exit
                // If abort was requested, continue the loop instead of exiting
                if (abortRequested) {
                    logger.debug('[local]: Aborting current operation, continuing local mode');
                    abortRequested = false; // Reset the flag
                    // Create a new AbortController for the next iteration
                    processAbortController = new AbortController();
                    exutFuture = new Future<void>();
                    continue; // Continue the loop to restart Claude
                }

                // Normal exit
                if (!exitReason) {
                    exitReason = 'exit';
                    break;
                }
            } catch (e) {
                const errorMessage = e instanceof Error ? e.message : String(e);
                logger.debug('[local]: launch error', e);

                // Check if abort was requested during the operation
                if (abortRequested) {
                    logger.debug('[local]: Aborting after error, continuing local mode');
                    abortRequested = false;
                    // Create a new AbortController for the next iteration
                    processAbortController = new AbortController();
                    exutFuture = new Future<void>();
                    continue;
                }

                // Always send error details to the app
                // Note: exitReason can be set by async callbacks (doAbort/doSwitch) during the await
                const reason = exitReason as 'switch' | 'exit' | null;
                if (reason === 'switch') {
                    session.client.sendSessionEvent({ type: 'message', message: `Error during mode switch: ${errorMessage}` });
                    break;
                } else if (reason === 'exit') {
                    session.client.sendSessionEvent({ type: 'message', message: `Error during exit: ${errorMessage}` });
                    break;
                } else {
                    session.client.sendSessionEvent({ type: 'message', message: `Process error: ${errorMessage}` });
                    continue;
                }
            }
            logger.debug('[local]: launch done');
        }
    } finally {

        // Resolve future
        exutFuture.resolve(undefined);

        // Set handlers to no-op
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => { });
        session.queue.setOnMessage(null);

        // Remove session found callback
        session.removeSessionFoundCallback(scannerSessionCallback);

        // Cleanup
        await scanner.cleanup();
    }

    // Return
    return exitReason || 'exit';
}