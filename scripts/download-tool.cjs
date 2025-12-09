#!/usr/bin/env node

/**
 * Downloads and extracts a tool binary on first use
 * Usage: node download-tool.cjs <toolName>
 *
 * This script is designed to be called before using a tool.
 * It's idempotent - if the tool is already downloaded, it does nothing.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream/promises');
const { getDownloadUrl, getBinaryName, getToolPath, TOOLS } = require('./tools-config.cjs');

/**
 * Follow redirects and download a file
 */
function downloadFile(url, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            reject(new Error('Too many redirects'));
            return;
        }

        const protocol = url.startsWith('https') ? https : require('http');

        protocol.get(url, (response) => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                downloadFile(response.headers.location, destPath, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`Download failed with status ${response.statusCode}`));
                return;
            }

            const fileStream = fs.createWriteStream(destPath);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', (err) => {
                fs.unlink(destPath, () => {}); // Clean up partial file
                reject(err);
            });
        }).on('error', reject);
    });
}

/**
 * Extract a tar.gz file
 */
async function extractTarGz(archivePath, destDir, toolName) {
    const tar = require('tar');
    const tool = TOOLS[toolName];

    await tar.extract({
        file: archivePath,
        cwd: destDir,
        filter: (entryPath) => {
            // Only extract the binary we need
            const binaryName = getBinaryName(toolName, os.platform());
            return entryPath.endsWith(binaryName);
        },
        strip: tool.archiveStructure === 'nested' ? 1 : 0
    });
}

/**
 * Extract a zip file (for Windows)
 */
async function extractZip(archivePath, destDir, toolName) {
    const AdmZip = require('adm-zip');
    const tool = TOOLS[toolName];
    const binaryName = getBinaryName(toolName, os.platform());

    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries();

    for (const entry of entries) {
        if (entry.entryName.endsWith(binaryName)) {
            const content = entry.getData();
            const destPath = path.join(destDir, binaryName);
            fs.writeFileSync(destPath, content);
            break;
        }
    }
}

/**
 * Ensure a tool is downloaded and available
 */
async function ensureTool(toolName) {
    const tool = TOOLS[toolName];
    if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
    }

    const platform = os.platform();
    const arch = os.arch();
    const toolPath = getToolPath(toolName);

    // Check if already downloaded
    if (fs.existsSync(toolPath)) {
        return toolPath;
    }

    const toolDir = path.dirname(toolPath);
    fs.mkdirSync(toolDir, { recursive: true });

    // Get download URL
    const url = getDownloadUrl(toolName, platform, arch);
    const isZip = url.endsWith('.zip');
    const archivePath = path.join(toolDir, `archive${isZip ? '.zip' : '.tar.gz'}`);

    console.error(`[happy-cli] Downloading ${toolName} v${tool.version}...`);

    try {
        // Download the archive
        await downloadFile(url, archivePath);

        // Extract
        if (isZip) {
            await extractZip(archivePath, toolDir, toolName);
        } else {
            await extractTarGz(archivePath, toolDir, toolName);
        }

        // Set executable permission on Unix
        if (platform !== 'win32') {
            fs.chmodSync(toolPath, 0o755);
        }

        // Clean up archive
        fs.unlinkSync(archivePath);

        console.error(`[happy-cli] ${toolName} v${tool.version} installed to ${toolPath}`);
        return toolPath;
    } catch (error) {
        // Clean up on failure
        try {
            fs.unlinkSync(archivePath);
        } catch {}
        throw error;
    }
}

/**
 * Run a tool, downloading it first if necessary
 * Returns the path to the binary
 */
async function getOrDownloadTool(toolName) {
    return ensureTool(toolName);
}

// If run directly, download the specified tool
if (require.main === module) {
    const toolName = process.argv[2];
    if (!toolName) {
        console.error('Usage: node download-tool.cjs <toolName>');
        console.error('Available tools:', Object.keys(TOOLS).join(', '));
        process.exit(1);
    }

    ensureTool(toolName)
        .then((toolPath) => {
            // Output the path so callers can use it
            console.log(toolPath);
        })
        .catch((error) => {
            console.error(`Failed to download ${toolName}:`, error.message);
            process.exit(1);
        });
}

module.exports = { ensureTool, getOrDownloadTool };
