/**
 * Sci-Trace Kernel Bridge (v2)
 * ----------------------------
 * This module is the "Glue" between the high-level entry points (Host/OpenClaw) 
 * and the low-level research engine (Python Kernel).
 * 
 * It handles the 'Interface Protocol' which allows the long-running Python process 
 * to stream status updates back to the Node.js event loop without blocking.
 */

const child_process = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * ARTIFACT MANAGEMENT
 * -------------------
 * The kernel generates high-resolution PNGs for every trace. To prevent 
 * disk saturation on the EC2 instance, we implement a simple 24-hour expiration policy.
 */
function cleanupArtifacts(artifactsDir) {
    if (!fs.existsSync(artifactsDir)) return;
    const files = fs.readdirSync(artifactsDir);
    const now = Date.now();
    const expiry = 24 * 60 * 60 * 1000; 

    files.forEach(file => {
        const filePath = path.join(artifactsDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > expiry) {
            fs.unlinkSync(filePath);
        }
    });
}

/**
 * SPAWN KERNEL
 * ------------
 * Launches the Python LangGraph engine and parses its stdout stream.
 * 
 * @param {string} topic - The scientific topic to research.
 * @param {Function} onEvent - An asynchronous callback for real-time [UI:*] events.
 * @returns {Promise<{imagePath: string, summary: string}>} - Resolves with final artifacts.
 */
function spawnKernel(topic, onEvent) {
    return new Promise((resolve, reject) => {
        const kernelPath = path.resolve(__dirname, '../../kernel/src/main.py');
        const venvPath = path.resolve(__dirname, '../../kernel/.venv/bin/python3');
        const artifactsDir = path.resolve(__dirname, '../../kernel/artifacts');

        // Cleanup before starting a new job to distribute the maintenance load.
        try {
            cleanupArtifacts(artifactsDir);
        } catch (err) {
            console.error(`[Bridge]: Artifact cleanup failed: ${err.message}`);
        }

        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }

        /**
         * PROCESS EXECUTION
         * We use 'spawn' instead of 'exec' because 'spawn' streams output in real-time,
         * whereas 'exec' buffers the entire output until completion (which would
         * break our real-time status updates in Discord).
         */
        const pythonProcess = child_process.spawn(venvPath, [kernelPath, '--topic', topic], {
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });
        
        // stdoutBuffer handles 'split chunks'. A single line from Python might be
        // received across multiple 'data' events.
        let stdoutBuffer = "";
        let finalSummary = "";
        let finalImagePath = null;

        pythonProcess.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            const lines = stdoutBuffer.split('\n');
            // Keep the last (potentially incomplete) line in the buffer.
            stdoutBuffer = lines.pop();

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;

                // PROTOCOL PARSING
                // We look for specific prefixes defined in 02_data_contracts.md
                const updateMatch = trimmedLine.match(/^\[UI:UPDATE\] (.*)/);
                const imageMatch = trimmedLine.match(/^\[UI:IMAGE\] (.*)/);
                const finalMatch = trimmedLine.match(/^\[UI:FINAL\] (.*)/);
                const errorMatch = trimmedLine.match(/^\[UI:ERROR\] (.*)/);

                if (updateMatch) {
                    onEvent({ type: 'update', message: updateMatch[1] });
                } else if (imageMatch) {
                    finalImagePath = imageMatch[1].trim();
                    onEvent({ type: 'image', path: finalImagePath });
                } else if (finalMatch) {
                    /**
                     * MULTI-LINE SUPPORT (Task 10)
                     * The Kernel escapes \n as \\n to keep the summary on a single stdout line.
                     * We unescape it here so Discord receives the correct Markdown formatting.
                     */
                    finalSummary = finalMatch[1].replace(/\\n/g, '\n');
                    onEvent({ type: 'final', summary: finalSummary });
                } else if (errorMatch) {
                    onEvent({ type: 'error', message: errorMatch[1] });
                } else {
                    // Raw logs from the kernel (not protocol tagged) are sent to the bridge logs.
                    console.log(`[Kernel]: ${trimmedLine}`);
                }
            }
        });

        pythonProcess.stderr.on('data', (data) => {
            // Standard error is used for Python tracebacks and system warnings.
            console.error(`[Kernel Stderr]: ${data}`);
        });

        pythonProcess.on('close', (code) => {
            // Drain the remaining buffer if it contains a final tag without a trailing newline.
            if (stdoutBuffer.trim()) {
                const trimmedLine = stdoutBuffer.trim();
                const finalMatch = trimmedLine.match(/^\[UI:FINAL\] (.*)/);
                if (finalMatch) {
                    finalSummary = finalMatch[1].replace(/\\n/g, '\n');
                }
            }

            if (code !== 0) {
                reject(new Error(`Kernel exited with code ${code}`));
            } else {
                resolve({ imagePath: finalImagePath, summary: finalSummary });
            }
        });

        pythonProcess.on('error', (err) => {
            reject(err);
        });
    });
}

module.exports = { spawnKernel };
