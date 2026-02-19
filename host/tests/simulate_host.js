/**
 * Host Logic Simulation
 * --------------------
 * Tests the queueing and concurrency logic implemented in index.js
 * by mocking Discord interactions and Kernel processes.
 */

const TRACE_CONCURRENCY_LIMIT = 2;
const TRACE_QUEUE_LIMIT = 5;
let activeTraces = 0;
const traceQueue = [];

// Mock Logging
function logToFile(msg) { console.log(`[SIM]: ${msg}`); }

// Mock Interaction Object
function createMockInteraction(id) {
    return {
        id,
        user: { tag: `User#${id}` },
        editReply: async (msg) => console.log(`   -> Interaction ${id} UI: ${msg}`),
        followUp: async (msg) => console.log(`   -> Interaction ${id} FOLLOWUP: ${msg.content || 'Embed/File'}`),
    };
}

// Mock Spawn Kernel
function mockSpawnKernel(topic, onUpdate, onImage, onFinal, onError) {
    console.log(`[KERNEL]: Starting trace for "${topic}"...`);

    const mockProcess = {
        on: (event, cb) => {
            if (event === 'close') {
                // Simulate process finishing after 2 seconds
                setTimeout(() => {
                    onFinal(`Summary for ${topic}`);
                    cb(0);
                }, 2000);
            }
        }
    };
    return mockProcess;
}

async function enqueueTrace(interaction, topic) {
    traceQueue.push({ interaction, topic });
    logToFile(`Trace queued. Position ${traceQueue.length}. Active: ${activeTraces}/${TRACE_CONCURRENCY_LIMIT}`);
    await interaction.editReply(`⏳ Queued at pos ${traceQueue.length}`);
}

async function startTrace(interaction, topic) {
    let traceFinished = false;
    const finishTrace = (reason) => {
        if (traceFinished) return;
        traceFinished = true;
        activeTraces = Math.max(0, activeTraces - 1);
        logToFile(`Slot released (${reason}). Active: ${activeTraces}/${TRACE_CONCURRENCY_LIMIT}`);

        if (traceQueue.length > 0 && activeTraces < TRACE_CONCURRENCY_LIMIT) {
            const nextJob = traceQueue.shift();
            activeTraces += 1;
            console.log(`[QUEUE]: Picking up next job: ${nextJob.topic}`);
            startTrace(nextJob.interaction, nextJob.topic);
        }
    };

    await interaction.editReply("🚀 Initializing...");

    const pythonProcess = mockSpawnKernel(
        topic,
        (upd) => interaction.editReply(`🔍 ${upd}`),
        (img) => interaction.followUp(`Image: ${img}`),
        (fin) => {
            interaction.followUp({ content: `Final: ${fin}` });
            finishTrace('final');
        },
        (err) => {
            interaction.followUp(`Error: ${err}`);
            finishTrace('error');
        }
    );

    pythonProcess.on('close', () => finishTrace('close'));
}

// --- SIMULATION RUN ---
async function runSimulation() {
    const topics = ["Topic A", "Topic B", "Topic C", "Topic D"];

    console.log("--- STARTING SIMULATION ---");

    for (let i = 0; i < topics.length; i++) {
        const topic = topics[i];
        const interaction = createMockInteraction(i + 1);

        console.log(`\n[REQUEST]: ${interaction.user.tag} requested ${topic}`);

        if (activeTraces >= TRACE_CONCURRENCY_LIMIT) {
            if (traceQueue.length >= TRACE_QUEUE_LIMIT) {
                console.log("   -> QUEUE FULL!");
                continue;
            }
            await enqueueTrace(interaction, topic);
        } else {
            activeTraces += 1;
            await startTrace(interaction, topic);
        }
    }
}

runSimulation();
