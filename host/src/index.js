/**
 * Sci-Trace Host (The Body)
 * ------------------------
 * This file is the entry point for the Node.js application.
 * Its primary purpose is to maintain a persistent connection to Discord,
 * handle user interactions (Slash Commands), and manage the lifecycle
 * of the ephemeral Python Kernel.
 */

const path = require('path');
// Initialize environment variables from the root .env file.
// This allows the host to access sensitive tokens (Discord, API Keys).
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fs = require('fs');
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    AttachmentBuilder,
    EmbedBuilder
} = require('discord.js');

// The bridge module contains the logic for spawning the Python child process.
const { spawnKernel } = require('./bridge');

/**
 * LOGGING INFRASTRUCTURE
 * ----------------------
 * To ensure observability in production, we maintain a persistent log file.
 * This is crucial for auditing user requests and tracking kernel performance.
 */
const logsDir = path.resolve(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    // Create the logs directory if it doesn't exist (e.g., first run on server).
    fs.mkdirSync(logsDir, { recursive: true });
}
const logFile = path.join(logsDir, 'app.log');

// We use an append-only write stream. This is more performance-efficient
// than synchronous file writing and ensures logs aren't lost during crashes.
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

/**
 * Utility to log messages with an ISO timestamp to both console and disk.
 * @param {string} message - The text to log.
 */
function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${message}\n`;
    process.stdout.write(logMsg); // Real-time console view (PM2 captures this)
    logStream.write(logMsg);      // Persistent storage
}

// Configuration constants pulled from environment variables.
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
// Soft semaphore: max number of concurrent kernel runs allowed.
const MAX_CONCURRENT_TRACES = Number.parseInt(process.env.MAX_CONCURRENT_TRACES ?? '2', 10);
const TRACE_CONCURRENCY_LIMIT = Number.isFinite(MAX_CONCURRENT_TRACES) && MAX_CONCURRENT_TRACES > 0
    ? MAX_CONCURRENT_TRACES
    : 2;
const MAX_TRACE_QUEUE_LENGTH = Number.parseInt(process.env.MAX_TRACE_QUEUE_LENGTH ?? '20', 10);
const TRACE_QUEUE_LIMIT = Number.isFinite(MAX_TRACE_QUEUE_LENGTH) && MAX_TRACE_QUEUE_LENGTH > 0
    ? MAX_TRACE_QUEUE_LENGTH
    : 20;
// Tracks how many traces are currently running.
let activeTraces = 0;
// FIFO queue for pending trace requests when at capacity.
const traceQueue = [];

// Fail-fast if essential credentials are missing.
if (!TOKEN || !CLIENT_ID) {
    console.error("CRITICAL ERROR: Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env");
    process.exit(1);
}

/**
 * DISCORD CLIENT INITIALIZATION
 * -----------------------------
 * We only request the 'Guilds' intent as we only interact via Slash Commands,
 * which does not require reading message content (improving privacy/security).
 */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/**
 * COMMAND DEFINITION
 * ------------------
 * Defines the schema for our slash commands. This is what users see
 * in the Discord UI when they type "/".
 */
const commands = [
    new SlashCommandBuilder()
        .setName('trace')
        .setDescription('Trace the intellectual lineage of a scientific topic')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('The topic or paper to trace (e.g., Self-RAG)')
                .setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

/**
 * Registers the defined slash commands with the Discord API.
 * This happens once every time the bot starts up.
 */
async function registerCommands() {
    try {
        logToFile('Started refreshing application (/) commands.');

        // If GUILD_ID is provided, commands register instantly in that specific server.
        // If not, they are registered globally (which can take up to 1 hour to propagate).
        if (GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        } else {
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        }
        logToFile('Successfully reloaded application (/) commands.');
    } catch (error) {
        logToFile(`ERROR: Command registration failed: ${error.message}`);
    }
}

/**
 * INPUT SANITIZATION
 * ------------------
 * Before passing any user string to the shell/Python, we must sanitize it.
 * This prevents "Command Injection" attacks where a malicious user
 * might try to run shell commands via the 'topic' field.
 */
function sanitizeTopic(topic) {
    // Strips out common shell control characters (; & | ` $ etc).
    return topic.replace(/[;&|`$(){}\[\]\n\r]/g, '').trim();
}

async function enqueueTrace(interaction, topic) {
    traceQueue.push({ interaction, topic });
    logToFile(`SYSTEM: Trace queued. Position ${traceQueue.length}. Active: ${activeTraces}/${TRACE_CONCURRENCY_LIMIT}`);

    await interaction.editReply(
        `⏳ Your trace is queued (position ${traceQueue.length}). You will receive updates shortly.`
    );
}

async function startTrace(interaction, topic) {
    let traceFinished = false;
    let pendingImagePath = null; // Buffer for the generated image path

    const finishTrace = (reason) => {
        if (traceFinished) return;
        traceFinished = true;
        // Release the slot exactly once.
        activeTraces = Math.max(0, activeTraces - 1);
        logToFile(`SYSTEM: Trace slot released (${reason}). Active: ${activeTraces}/${TRACE_CONCURRENCY_LIMIT}`);

        if (traceQueue.length > 0 && activeTraces < TRACE_CONCURRENCY_LIMIT) {
            const nextJob = traceQueue.shift();
            // Acquire slot for the next job from queue
            activeTraces += 1;
            startTrace(nextJob.interaction, nextJob.topic).catch(err => {
                logToFile(`QUEUE ERROR: Failed to start next trace: ${err.message}`);
                // Release slot if starting fails
                activeTraces = Math.max(0, activeTraces - 1);
            });
        }
    };

    let lastMessage = "🚀 Initializing Python Research Kernel...";
    await interaction.editReply(lastMessage);

    /**
     * KERNEL EXECUTION
     * ----------------
     * Spawns the child process and attaches the UI update callbacks.
     */
    const pythonProcess = spawnKernel(
        topic,
        // CALLBACK: On [UI:UPDATE] tag (Status changes)
        async (update) => {
            lastMessage = `🔍 ${update}`;
            // We edit the existing "thinking" message to show real-time progress.
            await interaction.editReply(lastMessage).catch(err => {
                logToFile(`UI ERROR: Failed to edit reply: ${err.message}`);
            });
        },
        // CALLBACK: On [UI:IMAGE] tag (Graph generation complete)
        async (imagePath) => {
            // We buffer the image path instead of sending it immediately,
            // so we can attach it to the final summary message.
            logToFile(`SYSTEM: Lineage plot generated at ${imagePath}. Buffering for final report.`);
            pendingImagePath = imagePath;
        },
        // CALLBACK: On [UI:FINAL] tag (Narrative synthesis complete)
        async (final) => {
            try {
                const embeds = [];
                const files = [];

                // Sends the human-readable summary as a clean Embed.
                const embed = new EmbedBuilder()
                    .setTitle(`Scientific Lineage: ${topic}`)
                    .setDescription(final)
                    .setColor(0x00AE86) // Success Green
                    .setTimestamp()
                    .setFooter({ text: 'Sci-Trace | Autonomous Research Agent' });

                // If an image was generated, attach it to the embed as the main image.
                if (pendingImagePath && fs.existsSync(pendingImagePath)) {
                    const filename = path.basename(pendingImagePath);
                    const attachment = new AttachmentBuilder(pendingImagePath, { name: filename });
                    embed.setImage(`attachment://${filename}`);
                    files.push(attachment);
                }

                embeds.push(embed);
                await interaction.followUp({ embeds, files });
                finishTrace('final');
            } catch (err) {
                logToFile(`UI ERROR: Failed to send final report: ${err.message}`);
                finishTrace('final-error');
            }
        },
        // CALLBACK: On [UI:ERROR] tag (Kernel-level failure)
        async (error) => {
            try {
                // Notifies the user of the failure without exposing internal stack traces.
                await interaction.followUp({
                    content: `❌ **Kernel Error:** ${error}\n*Check system logs for details.*`,
                    ephemeral: true
                });
                finishTrace('kernel-error');
            } catch (err) {
                logToFile(`UI ERROR: Failed to send error message: ${err.message}`);
                finishTrace('kernel-error');
            }
        }
    );

    // Safety net in case no final/error callback fires.
    pythonProcess.on('close', () => finishTrace('close'));
}

/**
 * EVENT: Bot Ready
 * Triggered when the WebSocket connection is successfully established.
 */
client.once('ready', () => {
    logToFile(`SYSTEM: Logged in as ${client.user.tag}!`);
    registerCommands();
});

/**
 * EVENT: Interaction Create
 * Handles the actual execution of the /trace command.
 */
client.on('interactionCreate', async interaction => {
    // We only care about Chat Input commands (Slash Commands).
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'trace') {
        const rawTopic = interaction.options.getString('topic');
        const topic = sanitizeTopic(rawTopic);

        logToFile(`[USER REQUEST]: ${interaction.user.tag} -> Trace topic: "${topic}"`);

        if (activeTraces >= TRACE_CONCURRENCY_LIMIT) {
            if (traceQueue.length >= TRACE_QUEUE_LIMIT) {
                await interaction.reply({
                    content: '⚠️ The queue is full right now. Please try again later.',
                    ephemeral: true
                });
                return;
            }

            await interaction.deferReply();
            await enqueueTrace(interaction, topic);
            return;
        }

        /**
         * DEFER REPLY
         * -----------
         * Research jobs can take 30-120 seconds. Discord requires a response
         * within 3 seconds. Deferring tells Discord "I am thinking",
         * extending our deadline to 15 minutes.
         */
        await interaction.deferReply();

        // Acquire slot immediately to prevent race conditions
        activeTraces += 1;
        await startTrace(interaction, topic);
    }
});

/**
 * GLOBAL ERROR HANDLING
 * ---------------------
 * Ensures the daemon doesn't stay dead if something unexpected happens.
 */
process.on('uncaughtException', (error) => {
    logToFile(`CRITICAL: Uncaught Exception: ${error.message}`);
    // PM2 will restart the process after it dies.
});

process.on('unhandledRejection', (reason, promise) => {
    logToFile(`CRITICAL: Unhandled Rejection: ${reason}`);
});

// Authenticate and start the heartbeat.
client.login(TOKEN);
