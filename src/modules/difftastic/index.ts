/**
 * Low-level difftastic wrapper - just arguments in, string out
 * Downloads the binary on first use from GitHub releases
 */

import { spawn, spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { projectPath } from '@/projectPath';

// Import the tool config to get the binary path
const toolsConfig = require(join(projectPath(), 'scripts', 'tools-config.cjs'));
const downloadTool = require(join(projectPath(), 'scripts', 'download-tool.cjs'));

export interface DifftasticResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface DifftasticOptions {
    cwd?: string
}

// Cache the binary path after first resolution
let cachedBinaryPath: string | null = null;

/**
 * Get the binary path, downloading if necessary
 * This is synchronous for simplicity - downloads happen once on first use
 */
function getBinaryPathSync(): string {
    if (cachedBinaryPath && existsSync(cachedBinaryPath)) {
        return cachedBinaryPath;
    }

    const expectedPath = toolsConfig.getToolPath('difftastic');

    // If binary exists, use it
    if (existsSync(expectedPath)) {
        cachedBinaryPath = expectedPath;
        return expectedPath;
    }

    // Download synchronously using a child process
    // This is a one-time operation on first use
    const result = spawnSync(process.execPath, [
        join(projectPath(), 'scripts', 'download-tool.cjs'),
        'difftastic'
    ], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'inherit'] // Show download progress on stderr
    });

    if (result.status !== 0) {
        throw new Error(`Failed to download difftastic: ${result.stderr || 'unknown error'}`);
    }

    // The script outputs the path on stdout
    cachedBinaryPath = result.stdout.trim();
    return cachedBinaryPath;
}

/**
 * Run difftastic with the given arguments
 * @param args - Array of command line arguments to pass to difftastic
 * @param options - Options for difftastic execution
 * @returns Promise with exit code, stdout and stderr
 */
export function run(args: string[], options?: DifftasticOptions): Promise<DifftasticResult> {
    const binaryPath = getBinaryPathSync();

    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: options?.cwd,
            env: {
                ...process.env,
                // Force color output when needed
                FORCE_COLOR: '1'
            }
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            resolve({
                exitCode: code || 0,
                stdout,
                stderr
            });
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}