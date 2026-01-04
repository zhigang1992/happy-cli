/**
 * Parsers for special commands that require dedicated remote session handling
 */

export interface CompactCommandResult {
    isCompact: boolean;
    originalMessage: string;
}

export interface ClearCommandResult {
    isClear: boolean;
}

export interface HappyStatusCommandResult {
    isHappyStatus: boolean;
    echoMessage?: string;
}

export interface DirectCommandResult {
    isDirectCommand: boolean;
    command?: string;
}

export interface SpecialCommandResult {
    type: 'compact' | 'clear' | 'happy-status' | 'direct-command' | null;
    originalMessage?: string;
    echoMessage?: string;
    command?: string;
}

/**
 * Parse /compact command
 * Matches messages starting with "/compact " or exactly "/compact"
 */
export function parseCompact(message: string): CompactCommandResult {
    const trimmed = message.trim();
    
    if (trimmed === '/compact') {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }
    
    if (trimmed.startsWith('/compact ')) {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }
    
    return {
        isCompact: false,
        originalMessage: message
    };
}

/**
 * Parse /clear command
 * Only matches exactly "/clear"
 */
export function parseClear(message: string): ClearCommandResult {
    const trimmed = message.trim();

    return {
        isClear: trimmed === '/clear'
    };
}

/**
 * Parse /happy-status command
 * Used for testing the message flow without calling Claude/Anthropic API
 * Format: "/happy-status" or "/happy-status some echo message"
 */
export function parseHappyStatus(message: string): HappyStatusCommandResult {
    const trimmed = message.trim();

    if (trimmed === '/happy-status') {
        return {
            isHappyStatus: true
        };
    }

    if (trimmed.startsWith('/happy-status ')) {
        return {
            isHappyStatus: true,
            echoMessage: trimmed.substring('/happy-status '.length).trim()
        };
    }

    return {
        isHappyStatus: false
    };
}

/**
 * Parse !command for direct shell command execution
 * Matches messages starting with "!" followed by a shell command
 * This mimics Claude Code CLI's native "!" command feature
 */
export function parseDirectCommand(message: string): DirectCommandResult {
    const trimmed = message.trim();

    if (trimmed.startsWith('!')) {
        const command = trimmed.substring(1).trim();
        if (command.length > 0) {
            return {
                isDirectCommand: true,
                command
            };
        }
    }

    return {
        isDirectCommand: false
    };
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
    const compactResult = parseCompact(message);
    if (compactResult.isCompact) {
        return {
            type: 'compact',
            originalMessage: compactResult.originalMessage
        };
    }

    const clearResult = parseClear(message);
    if (clearResult.isClear) {
        return {
            type: 'clear'
        };
    }

    const happyStatusResult = parseHappyStatus(message);
    if (happyStatusResult.isHappyStatus) {
        return {
            type: 'happy-status',
            echoMessage: happyStatusResult.echoMessage
        };
    }

    const directCommandResult = parseDirectCommand(message);
    if (directCommandResult.isDirectCommand) {
        return {
            type: 'direct-command',
            command: directCommandResult.command
        };
    }

    return {
        type: null
    };
}