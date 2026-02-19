/**
 * Sci-Trace Kernel Bridge
 * -----------------------
 * This module is the "Glue" between the Node.js Host and the Python Kernel.
 * Its primary responsibility is to spawn the Python process, maintain
 * its lifecycle, and parse its Standard Output (stdout) stream
 * into UI actions for Discord.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * ARTIFACT LIFECYCLE MANAGEMENT
 * -----------------------------
 * To prevent the server's disk from filling up with temporary lineage graphs,
 * we implement a simple expiration-based cleanup.
 *
 * @param {string} artifactsDir - Path to the directory containing generated PNGs.
 */
function cleanupArtifacts(artifactsDir) {
    if (!fs.existsSync(artifactsDir)) return;

    const files = fs.readdirSync(artifactsDir);
    const now = Date.now();
    const expiry = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds

    files.forEach(file => {
        const filePath = path.join(artifactsDir, file);
        const stats = fs.statSync(filePath);

        // If the file is older than 24 hours, delete it.
        if (now - stats.mtimeMs > expiry) {
            console.log(`[Host]: Cleaning up expired artifact: ${file}`);
            fs.unlinkSync(filePath); // Synchronous delete is safe here as batches are small.
        }
    });
}

/**
 * SPAWN KERNEL
 * ------------
 * Launches the Python LangGraph engine as a child process.
 *
 * @param {string} topic - The scientific topic to research.
 * @param {Function} onUpdate - Callback for status messages ([UI:UPDATE]).
 * @param {Function} onImage - Callback for file uploads ([UI:IMAGE]).
 * @param {Function} onFinal - Callback for completion ([UI:FINAL]).
 * @param {Function} onError - Callback for failures ([UI:ERROR]).
 */
function spawnKernel(topic, onUpdate, onImage, onFinal, onError) {
    // RESOLVE PATHS: Ensure we point to the correct files regardless of where PM2 is started.
    const kernelPath = path.resolve(__dirname, '../../kernel/src/main.py');
    const venvPath = path.resolve(__dirname, '../../kernel/.venv/bin/python3');
    const artifactsDir = path.resolve(__dirname, '../../kernel/artifacts');

    /**
     * MAINTENANCE TASK
     * ----------------
     * We run cleanup every time a new trace starts.
     * This distributes the cleanup work and ensures the folder is lean
     * before the next image is generated.
     */
    try {
        cleanupArtifacts(artifactsDir);
    } catch (err) {
        console.error(`[Host]: Artifact cleanup failed: ${err.message}`);
    }

    // Ensure the artifacts directory exists so the Kernel doesn't crash trying to save to it.
    if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
    }

    /**
     * PROCESS SPAWNING
     * ----------------
     * We use 'spawn' instead of 'exec' because the research kernel is long-running.
     * 'spawn' allows us to stream the output in real-time rather than waiting
     * for the process to finish.
     */
    // Configuration for trace depth (Default to 5 if not set)
    const maxDepth = process.env.MAX_TRACE_DEPTH || '5';

    const pythonProcess = spawn(venvPath, [
        kernelPath, 
        '--topic', topic,
        '--max_depth', maxDepth
    ]);

    /**
     * STDOUT STREAM BUFFERING (The "Bridge" Logic)
     * --------------------------------------------
     * Problem: Standard Output is a stream of data chunks. A single line
     * from Python might be split into multiple chunks during transit.
     *
     * Solution: We use a 'stdoutBuffer' to accumulate chunks until we see a
     * newline character (\n), ensuring we only parse complete protocol tags.
     */
    let stdoutBuffer = "";

    // Stream stdout in chunks, then parse complete tagged lines into UI callbacks.
    pythonProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');

        // Remove the last element (which is either an empty string if the chunk
        // ended in \n, or a partial line) and keep it in the buffer for the next chunk.
        stdoutBuffer = lines.pop();

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            /**
             * REGEX PROTOCOL PARSING
             * ----------------------
             * We look for specific [UI:TAG] prefixes defined in the project contracts.
             */
            const updateMatch = trimmedLine.match(/^\[UI:UPDATE\] (.*)/);
            const imageMatch = trimmedLine.match(/^\[UI:IMAGE\] (.*)/);
            const finalMatch = trimmedLine.match(/^\[UI:FINAL\] (.*)/);
            const errorMatch = trimmedLine.match(/^\[UI:ERROR\] (.*)/);

            if (updateMatch) {
                onUpdate(updateMatch[1]);
            } else if (imageMatch) {
                // Returns the absolute file path to the generated image.
                onImage(imageMatch[1].trim());
            } else if (finalMatch) {
                // Returns the final Markdown summary.
                // We unescape \n back to actual newlines for multi-line output.
                onFinal(finalMatch[1].replace(/\\n/g, '\n'));
            } else if (errorMatch) {
                // Returns a specific error message from the Kernel.
                onError(errorMatch[1]);
            } else {
                // If it doesn't match our protocol, log it as a raw Kernel message.
                console.log(`[Kernel Log]: ${trimmedLine}`);
            }
        }
    });

    /**
     * STDERR HANDLING
     * ---------------
     * Captures Python tracebacks or warnings. These are logged to the Host's
     * persistent log but not shown to the Discord user to avoid confusion.
     */
    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Kernel Stderr]: ${data}`);
    });

    /**
     * PROCESS CLOSURE
     * ---------------
     * Triggered when the Python Kernel finishes execution or crashes.
     */
    pythonProcess.on('close', (code) => {
        /**
         * EDGE CASE: BUFFER DRAIN
         * If the process ends without a final newline, we parse the last bits.
         */
        if (stdoutBuffer.trim()) {
            const trimmedLine = stdoutBuffer.trim();
            
            const updateMatch = trimmedLine.match(/^\[UI:UPDATE\] (.*)/);
            const imageMatch = trimmedLine.match(/^\[UI:IMAGE\] (.*)/);
            const finalMatch = trimmedLine.match(/^\[UI:FINAL\] (.*)/);
            const errorMatch = trimmedLine.match(/^\[UI:ERROR\] (.*)/);

            if (updateMatch) {
                onUpdate(updateMatch[1]);
            } else if (imageMatch) {
                onImage(imageMatch[1].trim());
            } else if (finalMatch) {
                onFinal(finalMatch[1]);
            } else if (errorMatch) {
                onError(errorMatch[1]);
            }
        }

        /**
         * CRASH DETECTION
         * A non-zero exit code means the Kernel failed (e.g., API keys missing,
         * network error, or logic crash).
         */
        if (code !== 0) {
            console.error(`Kernel process exited with error code ${code}`);
            onError(`Process crashed with code ${code}. Check server logs.`);
        }
    });

    return pythonProcess;
}

module.exports = { spawnKernel };
