/**
 * Configuration for external tool binaries
 * These are downloaded on first use, not bundled with the package
 */

const TOOLS = {
    difftastic: {
        version: '0.64.0',
        repo: 'Wilfred/difftastic',
        // Map platform/arch to GitHub release asset names
        assets: {
            'darwin-arm64': 'difft-aarch64-apple-darwin.tar.gz',
            'darwin-x64': 'difft-x86_64-apple-darwin.tar.gz',
            'linux-arm64': 'difft-aarch64-unknown-linux-gnu.tar.gz',
            'linux-x64': 'difft-x86_64-unknown-linux-gnu.tar.gz',
            'win32-x64': 'difft-x86_64-pc-windows-msvc.zip',
        },
        // Binary name inside the archive (or after extraction)
        binaryName: {
            'win32': 'difft.exe',
            'default': 'difft'
        },
        // Some archives have the binary in a subdirectory
        archiveStructure: 'flat' // binary is at root of archive
    },
    ripgrep: {
        version: '14.1.1',
        repo: 'BurntSushi/ripgrep',
        assets: {
            'darwin-arm64': 'ripgrep-14.1.1-aarch64-apple-darwin.tar.gz',
            'darwin-x64': 'ripgrep-14.1.1-x86_64-apple-darwin.tar.gz',
            'linux-arm64': 'ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz',
            'linux-x64': 'ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz',
            'win32-x64': 'ripgrep-14.1.1-x86_64-pc-windows-msvc.zip',
        },
        binaryName: {
            'win32': 'rg.exe',
            'default': 'rg'
        },
        // ripgrep archives have files in a subdirectory named after the archive
        archiveStructure: 'nested' // binary is in a subdirectory
    }
};

/**
 * Get download URL for a tool
 */
function getDownloadUrl(toolName, platform, arch) {
    const tool = TOOLS[toolName];
    if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
    }

    const key = `${platform}-${arch}`;
    const asset = tool.assets[key];
    if (!asset) {
        throw new Error(`Unsupported platform for ${toolName}: ${key}`);
    }

    return `https://github.com/${tool.repo}/releases/download/${tool.version}/${asset}`;
}

/**
 * Get binary name for a tool on the current platform
 */
function getBinaryName(toolName, platform) {
    const tool = TOOLS[toolName];
    if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
    }

    return tool.binaryName[platform] || tool.binaryName['default'];
}

/**
 * Get cache directory for tools
 * Uses ~/.cache/happy-cli/tools on Unix, %LOCALAPPDATA%/happy-cli/tools on Windows
 */
function getCacheDir() {
    const os = require('os');
    const path = require('path');

    const platform = os.platform();
    const homeDir = os.homedir();

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
        return path.join(localAppData, 'happy-cli', 'tools');
    } else {
        const cacheHome = process.env.XDG_CACHE_HOME || path.join(homeDir, '.cache');
        return path.join(cacheHome, 'happy-cli', 'tools');
    }
}

/**
 * Get the expected path for a tool binary
 */
function getToolPath(toolName) {
    const os = require('os');
    const path = require('path');

    const tool = TOOLS[toolName];
    if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
    }

    const cacheDir = getCacheDir();
    const binaryName = getBinaryName(toolName, os.platform());

    return path.join(cacheDir, toolName, tool.version, binaryName);
}

module.exports = {
    TOOLS,
    getDownloadUrl,
    getBinaryName,
    getCacheDir,
    getToolPath
};
