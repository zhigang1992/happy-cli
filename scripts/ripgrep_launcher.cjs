#!/usr/bin/env node

/**
 * Ripgrep runner - executed as a subprocess to run the native module
 * This file is intentionally written in CommonJS to avoid ESM complexities
 *
 * Uses the ripgrep.node native module bundled with @anthropic-ai/claude-code
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Get the platform-specific directory name for claude-code vendor
 */
function getPlatformDir() {
    const platform = os.platform();
    const arch = os.arch();

    if (platform === 'darwin') {
        return arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin';
    } else if (platform === 'linux') {
        return arch === 'arm64' ? 'arm64-linux' : 'x64-linux';
    } else if (platform === 'win32') {
        return 'x64-win32';
    }
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Find the ripgrep.node native module
 * First checks claude-code vendor directory, falls back to local tools
 */
function findRipgrepModule() {
    const platformDir = getPlatformDir();

    // Try claude-code vendor first (preferred - it's always up to date)
    const claudeCodePaths = [
        // When installed as a dependency
        path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'vendor', 'ripgrep', platformDir, 'ripgrep.node'),
        // When running from workspace root
        path.join(__dirname, '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'vendor', 'ripgrep', platformDir, 'ripgrep.node'),
    ];

    for (const modulePath of claudeCodePaths) {
        if (fs.existsSync(modulePath)) {
            return modulePath;
        }
    }

    // Fallback to local tools/unpacked (for development)
    const localPath = path.join(__dirname, '..', 'tools', 'unpacked', 'ripgrep.node');
    if (fs.existsSync(localPath)) {
        return localPath;
    }

    throw new Error('Could not find ripgrep.node native module. Make sure @anthropic-ai/claude-code is installed.');
}

// Load the native module
const modulePath = findRipgrepModule();
const ripgrepNative = require(modulePath);

// Get arguments from command line (skip node and script name)
const args = process.argv.slice(2);

// Parse the JSON-encoded arguments
let parsedArgs;
try {
    parsedArgs = JSON.parse(args[0]);
} catch (error) {
    console.error('Failed to parse arguments:', error.message);
    process.exit(1);
}

// Run ripgrep
try {
    const exitCode = ripgrepNative.ripgrepMain(parsedArgs);
    process.exit(exitCode);
} catch (error) {
    console.error('Ripgrep error:', error.message);
    process.exit(1);
}