const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Deletes artifacts in the artifacts directory older than 24 hours.
 */
function cleanupArtifacts(artifactsDir) {
    if (!fs.existsSync(artifactsDir)) return;

    const files = fs.readdirSync(artifactsDir);
    const now = Date.now();
    const expiry = 24 * 60 * 60 * 1000; // 24 Hours

    files.forEach(file => {
        const filePath = path.join(artifactsDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > expiry) {
            console.log(`[Host]: Cleaning up expired artifact: ${file}`);
            fs.unlinkSync(filePath);
        }
    });
}

/**
 * Spawns the Python Kernel and attaches listeners to stdout to communicate with Discord.
...
 */
function spawnKernel(topic, onUpdate, onImage, onFinal, onError) {
    const kernelPath = path.resolve(__dirname, '../../kernel/src/main.py');
    const venvPath = path.resolve(__dirname, '../../kernel/.venv/bin/python3');
    const artifactsDir = path.resolve(__dirname, '../../kernel/artifacts');

    // Task 1: Clean up old artifacts before starting a new run
    try {
        cleanupArtifacts(artifactsDir);
    } catch (err) {
        console.error(`[Host]: Artifact cleanup failed: ${err.message}`);
    }

    // Ensure artifacts directory exists
    if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
    }

    const pythonProcess = spawn(venvPath, [kernelPath, '--topic', topic]);

    pythonProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;

            const updateMatch = line.match(/^\[UI:UPDATE\] (.*)/);
            const imageMatch = line.match(/^\[UI:IMAGE\] (.*)/);
            const finalMatch = line.match(/^\[UI:FINAL\] (.*)/);
            const errorMatch = line.match(/^\[UI:ERROR\] (.*)/);

            if (updateMatch) {
                onUpdate(updateMatch[1]);
            } else if (imageMatch) {
                onImage(imageMatch[1].trim());
            } else if (finalMatch) {
                onFinal(finalMatch[1]);
            } else if (errorMatch) {
                onError(errorMatch[1]);
            } else {
                console.log(`[Kernel Log]: ${line}`);
            }
        }
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Kernel Stderr]: ${data}`);
    });

    pythonProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`Kernel process exited with code ${code}`);
            onError(`Process crashed with code ${code}`);
        }
    });

    return pythonProcess;
}

module.exports = { spawnKernel };
