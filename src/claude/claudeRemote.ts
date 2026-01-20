import { EnhancedMode, PermissionMode } from "./loop";
import { query, Query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, type SDKAssistantMessage, type SDKResultMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join, resolve } from 'node:path';
import { projectPath } from "@/projectPath";
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import { loadDirenvEnvironment } from "@/utils/direnv";
import { ImageRefContent } from "@/api/types";
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execAsync = promisify(exec);

/** Resolved image in Claude API format */
export interface ResolvedImage {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
}

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    hookSettingsPath?: string,
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,

    // Image resolution callback
    resolveImageRefs?: (imageRefs: ImageRefContent[]) => Promise<ResolvedImage[]>,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    onStderr?: (data: string) => void,
    /** Called when Query object is created, allows caller to call interrupt() */
    onQueryCreated?: (query: Query, isIdle: () => boolean) => void
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    // Extract --resume and --fork-session from claudeArgs if present (for first spawn)
    let forkSession = false;
    if (opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--fork-session') {
                forkSession = true;
                logger.debug('[claudeRemote] Found --fork-session flag');
            }
            if (!startFrom && opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                }
            }
        }
    }

    // Load direnv environment for the working directory
    const direnvVars = await loadDirenvEnvironment(opts.path);
    if (Object.keys(direnvVars).length > 0) {
        logger.debug(`[claudeRemote] Loaded ${Object.keys(direnvVars).length} direnv environment variables`);
    }

    // Set environment variables for Claude Code SDK
    // Order: process.env < direnv < explicit claudeEnvVars
    // Apply direnv variables first
    Object.entries(direnvVars).forEach(([key, value]) => {
        process.env[key] = value;
    });

    // Then apply explicit claudeEnvVars (highest priority)
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Handle /happy-status command - generates synthetic messages without calling Claude
    if (specialCommand.type === 'happy-status') {
        logger.debug('[claudeRemote] /happy-status command detected - generating test messages without Claude');

        // Generate a test session ID if not resuming
        const testSessionId = startFrom || `test-session-${Date.now()}`;
        opts.onSessionFound(testSessionId);

        // Create synthetic messages that mimic real Claude SDK output
        const echoMessage = specialCommand.echoMessage || 'Happy CLI status check';
        const timestamp = new Date().toISOString();

        // Send user message (echo of what was sent)
        opts.onMessage({
            type: 'user',
            message: {
                role: 'user',
                content: initial.message
            }
        } as SDKUserMessage);

        // Send system init message
        opts.onMessage({
            type: 'system',
            subtype: 'init',
            session_id: testSessionId,
            cwd: opts.path,
            model: 'happy-status-test',
            tools: []
        } as SDKSystemMessage);

        // Send assistant response
        const responseText = `Happy Status Check - ${timestamp}\n\n` +
            `✓ CLI is running\n` +
            `✓ Server connection established\n` +
            `✓ Session ID: ${testSessionId}\n` +
            `✓ Working directory: ${opts.path}\n` +
            (echoMessage !== 'Happy CLI status check' ? `\nEcho message: ${echoMessage}` : '');

        opts.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'text',
                    text: responseText
                }]
            }
        } as SDKAssistantMessage);

        // Send result message to indicate completion
        opts.onMessage({
            type: 'result',
            subtype: 'success',
            session_id: testSessionId
        } as SDKResultMessage);

        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Status check completed');
        }
        opts.onReady();

        return;
    }

    // Handle !command for direct shell execution - bypasses AI completely
    if (specialCommand.type === 'direct-command' && specialCommand.command) {
        logger.debug(`[claudeRemote] Direct command detected: ${specialCommand.command}`);

        // Generate a test session ID if not resuming
        const directSessionId = startFrom || `direct-cmd-${Date.now()}`;
        opts.onSessionFound(directSessionId);

        // Send user message (echo of what was sent)
        opts.onMessage({
            type: 'user',
            message: {
                role: 'user',
                content: initial.message
            }
        } as SDKUserMessage);

        // Send system init message
        opts.onMessage({
            type: 'system',
            subtype: 'init',
            session_id: directSessionId,
            cwd: opts.path,
            model: 'direct-command',
            tools: []
        } as SDKSystemMessage);

        // Execute the command directly
        try {
            const { stdout, stderr } = await execAsync(specialCommand.command, {
                cwd: opts.path,
                timeout: 30000, // 30 second timeout
                env: process.env as Record<string, string>
            });

            // Format output similar to terminal
            let output = '';
            if (stdout) {
                output += stdout;
            }
            if (stderr) {
                output += stderr;
            }

            // Send assistant response with command output
            opts.onMessage({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'text',
                        text: output || '(no output)'
                    }]
                }
            } as SDKAssistantMessage);

            // Send success result
            opts.onMessage({
                type: 'result',
                subtype: 'success',
                session_id: directSessionId,
                num_turns: 0,
                total_cost_usd: 0,
                duration_ms: 0,
                duration_api_ms: 0,
                is_error: false
            } as SDKResultMessage);

            if (opts.onCompletionEvent) {
                opts.onCompletionEvent('Command executed');
            }
        } catch (error: any) {
            // Handle command errors
            const execError = error as NodeJS.ErrnoException & {
                stdout?: string;
                stderr?: string;
                code?: number | string;
            };

            let errorOutput = '';
            if (execError.stdout) errorOutput += execError.stdout;
            if (execError.stderr) errorOutput += execError.stderr;
            if (!errorOutput) errorOutput = execError.message || 'Command failed';

            // Send assistant response with error
            opts.onMessage({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'text',
                        text: `Error: ${errorOutput}`
                    }]
                }
            } as SDKAssistantMessage);

            // Send error result
            opts.onMessage({
                type: 'result',
                subtype: 'error_during_execution',
                session_id: directSessionId,
                num_turns: 0,
                total_cost_usd: 0,
                duration_ms: 0,
                duration_api_ms: 0,
                is_error: true
            } as SDKResultMessage);

            if (opts.onCompletionEvent) {
                opts.onCompletionEvent('Command failed');
            }
        }

        opts.onReady();
        return;
    }

    // Prepare SDK options
    let mode = initial.mode;
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        forkSession,
        mcpServers: opts.mcpServers,
        permissionMode: initial.mode.permissionMode === 'plan' ? 'plan' : 'default',
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        executable: 'node',
        abort: opts.signal,
        pathToClaudeCodeExecutable: (() => {
            return resolve(join(projectPath(), 'scripts', 'claude_remote_launcher.cjs'));
        })(),
        settingsPath: opts.hookSettingsPath,
        onStderr: opts.onStderr,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Helper to build message content with images
    async function buildMessageContent(text: string, imageRefs?: ImageRefContent[]): Promise<string | Array<{ type: string; [key: string]: unknown }>> {
        // If no images, return simple string
        if (!imageRefs || imageRefs.length === 0 || !opts.resolveImageRefs) {
            return text;
        }

        // Resolve images and build content array
        logger.debug(`[claudeRemote] Resolving ${imageRefs.length} image references`);
        const resolvedImages = await opts.resolveImageRefs(imageRefs);
        logger.debug(`[claudeRemote] Resolved ${resolvedImages.length} images`);

        if (resolvedImages.length === 0) {
            // No images resolved, return simple text
            return text;
        }

        // Build content array: images first, then text
        const content: Array<{ type: string; [key: string]: unknown }> = [];

        // Add resolved images (double cast to satisfy index signature)
        for (const img of resolvedImages) {
            content.push(img as unknown as { type: string; [key: string]: unknown });
        }

        // Add text content
        if (text) {
            content.push({ type: 'text', text });
        }

        return content;
    }

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    const initialContent = await buildMessageContent(initial.message, initial.mode.imageRefs);
    messages.push({
        type: 'user',
        uuid: randomUUID(),  // UUID is required for Claude CLI streaming mode
        message: {
            role: 'user',
            content: initialContent,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    // Track if we're waiting for the next user message
    // This is used to signal when we're ready for new messages
    // Also used by interrupt logic - when true, session is idle (no active work)
    let waitingForNextMessage = false;
    let messagePusherStopped = false;

    // Notify caller about the query object so they can call interrupt()
    if (opts.onQueryCreated) {
        opts.onQueryCreated(response, () => waitingForNextMessage);
    }

    // Start a background task to push user messages to SDK
    // This runs independently of the SDK message receiving loop to avoid blocking
    // when task notifications arrive (e.g., background task completions)
    const messagePusherTask = (async () => {
        try {
            while (!messagePusherStopped) {
                // Wait until we're ready for the next message
                if (!waitingForNextMessage) {
                    await new Promise<void>(resolve => {
                        const checkInterval = setInterval(() => {
                            if (waitingForNextMessage || messagePusherStopped) {
                                clearInterval(checkInterval);
                                resolve();
                            }
                        }, 10);
                    });
                }

                if (messagePusherStopped) {
                    break;
                }

                logger.debug('[claudeRemote] Message pusher waiting for next message');
                const next = await opts.nextMessage();

                if (!next) {
                    logger.debug('[claudeRemote] No more messages, ending message stream');
                    messages.end();
                    break;
                }

                logger.debug('[claudeRemote] Message pusher received new message, pushing to SDK');
                mode = next.mode;
                const nextContent = await buildMessageContent(next.message, next.mode.imageRefs);
                messages.push({
                    type: 'user',
                    uuid: randomUUID(),
                    message: { role: 'user', content: nextContent }
                });

                // Reset flag - we'll set it again when we receive a result
                waitingForNextMessage = false;
            }
        } catch (e) {
            logger.debug('[claudeRemote] Message pusher error:', e);
        }
    })();

    updateThinking(true);
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Handle messages
            opts.onMessage(message);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received');

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event and signal that we're ready for the next message
                // The message pusher task will handle waiting for and pushing the next message
                // This allows the for-await loop to continue receiving SDK messages
                // (e.g., from task notifications) without blocking
                opts.onReady();
                waitingForNextMessage = true;
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            messagePusherStopped = true;
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
        messagePusherStopped = true;
        // Wait for message pusher to stop (with timeout)
        await Promise.race([
            messagePusherTask,
            new Promise(resolve => setTimeout(resolve, 100))
        ]);
    }
}