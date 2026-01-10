/**
 * Custom Slash Command Discovery and Parsing
 *
 * Discovers custom slash commands from:
 * - Project commands: .claude/commands/
 * - Personal commands: ~/.claude/commands/
 *
 * Parses markdown files with optional YAML frontmatter for metadata.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '@/ui/logger'

export interface CustomCommand {
    name: string                    // Command name (filename without .md)
    description?: string            // From frontmatter or first line
    argumentHint?: string           // From frontmatter: argument-hint
    allowedTools?: string[]         // From frontmatter: allowed-tools
    model?: string                  // From frontmatter: model
    scope: 'project' | 'personal'   // Where the command was found
    namespace?: string              // Subdirectory namespace (e.g., "frontend")
    filePath: string                // Full path to the command file
    content: string                 // The command content (after frontmatter)
}

interface Frontmatter {
    description?: string
    'argument-hint'?: string
    'allowed-tools'?: string | string[]
    model?: string
    hooks?: unknown
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns the frontmatter object and remaining content
 */
function parseFrontmatter(content: string): { frontmatter: Frontmatter | null, body: string } {
    const trimmed = content.trim()

    // Check if content starts with frontmatter delimiter
    if (!trimmed.startsWith('---')) {
        return { frontmatter: null, body: content }
    }

    // Find the closing delimiter
    const endIndex = trimmed.indexOf('---', 3)
    if (endIndex === -1) {
        return { frontmatter: null, body: content }
    }

    const frontmatterStr = trimmed.substring(3, endIndex).trim()
    const body = trimmed.substring(endIndex + 3).trim()

    // Simple YAML parser for frontmatter fields we care about
    const frontmatter: Frontmatter = {}
    const lines = frontmatterStr.split('\n')

    for (const line of lines) {
        const colonIndex = line.indexOf(':')
        if (colonIndex === -1) continue

        const key = line.substring(0, colonIndex).trim()
        let value = line.substring(colonIndex + 1).trim()

        // Handle array values (comma-separated)
        if (key === 'allowed-tools' && value) {
            frontmatter['allowed-tools'] = value.split(',').map(s => s.trim())
        } else if (key === 'description') {
            frontmatter.description = value
        } else if (key === 'argument-hint') {
            frontmatter['argument-hint'] = value
        } else if (key === 'model') {
            frontmatter.model = value
        }
    }

    return { frontmatter, body }
}

/**
 * Extract description from command content if not in frontmatter
 * Uses the first non-empty line as description
 */
function extractDescriptionFromContent(content: string): string | undefined {
    const lines = content.split('\n')
    for (const line of lines) {
        const trimmed = line.trim()
        // Skip markdown headers and empty lines
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('!')) {
            // Truncate to reasonable length
            return trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed
        }
    }
    return undefined
}

/**
 * Recursively find all .md files in a directory
 * Returns array of { filePath, namespace }
 */
function findMarkdownFiles(
    dir: string,
    baseDir: string = dir
): Array<{ filePath: string, namespace?: string }> {
    const results: Array<{ filePath: string, namespace?: string }> = []

    if (!existsSync(dir)) {
        return results
    }

    try {
        const entries = readdirSync(dir)

        for (const entry of entries) {
            const fullPath = join(dir, entry)
            const stat = statSync(fullPath)

            if (stat.isDirectory()) {
                // Recurse into subdirectory
                const subResults = findMarkdownFiles(fullPath, baseDir)
                results.push(...subResults)
            } else if (stat.isFile() && extname(entry).toLowerCase() === '.md') {
                // Get namespace from directory structure
                const relativePath = fullPath.substring(baseDir.length + 1)
                const namespace = relativePath.includes('/')
                    ? relativePath.substring(0, relativePath.lastIndexOf('/'))
                    : undefined

                results.push({ filePath: fullPath, namespace })
            }
        }
    } catch (error) {
        logger.debug('[customCommands] Error reading directory:', dir, error)
    }

    return results
}

/**
 * Parse a single command file into a CustomCommand object
 */
function parseCommandFile(
    filePath: string,
    namespace: string | undefined,
    scope: 'project' | 'personal'
): CustomCommand | null {
    try {
        const content = readFileSync(filePath, 'utf-8')
        const { frontmatter, body } = parseFrontmatter(content)

        // Get command name from filename (without .md extension)
        const name = basename(filePath, '.md')

        // Get description from frontmatter or content
        const description = frontmatter?.description || extractDescriptionFromContent(body)

        // Parse allowed-tools
        let allowedTools: string[] | undefined
        if (frontmatter?.['allowed-tools']) {
            const at = frontmatter['allowed-tools']
            allowedTools = Array.isArray(at) ? at : [at]
        }

        return {
            name,
            description,
            argumentHint: frontmatter?.['argument-hint'],
            allowedTools,
            model: frontmatter?.model,
            scope,
            namespace,
            filePath,
            content: body
        }
    } catch (error) {
        logger.debug('[customCommands] Error parsing command file:', filePath, error)
        return null
    }
}

/**
 * Discover all custom commands from project and personal directories
 *
 * @param projectDir - The project root directory (where .claude/commands/ might exist)
 * @returns Array of discovered custom commands
 */
export function discoverCustomCommands(projectDir: string): CustomCommand[] {
    const commands: CustomCommand[] = []

    // Project commands: .claude/commands/
    const projectCommandsDir = join(projectDir, '.claude', 'commands')
    if (existsSync(projectCommandsDir)) {
        logger.debug('[customCommands] Scanning project commands:', projectCommandsDir)
        const files = findMarkdownFiles(projectCommandsDir)

        for (const { filePath, namespace } of files) {
            const command = parseCommandFile(filePath, namespace, 'project')
            if (command) {
                commands.push(command)
            }
        }
    }

    // Personal commands: ~/.claude/commands/
    const personalCommandsDir = join(homedir(), '.claude', 'commands')
    if (existsSync(personalCommandsDir)) {
        logger.debug('[customCommands] Scanning personal commands:', personalCommandsDir)
        const files = findMarkdownFiles(personalCommandsDir)

        for (const { filePath, namespace } of files) {
            const command = parseCommandFile(filePath, namespace, 'personal')
            if (command) {
                // Check if this command is already defined in project (project takes precedence)
                const existingIndex = commands.findIndex(c => c.name === command.name)
                if (existingIndex === -1) {
                    commands.push(command)
                } else {
                    logger.debug(`[customCommands] Skipping personal command "${command.name}" - project command takes precedence`)
                }
            }
        }
    }

    logger.debug(`[customCommands] Discovered ${commands.length} custom commands`)
    return commands
}

/**
 * Convert CustomCommand array to metadata format for session sync
 */
export interface CustomCommandMetadata {
    name: string
    description?: string
    argumentHint?: string
    scope: 'project' | 'personal'
    namespace?: string
}

export function commandsToMetadata(commands: CustomCommand[]): CustomCommandMetadata[] {
    return commands.map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        scope: cmd.scope,
        namespace: cmd.namespace
    }))
}
