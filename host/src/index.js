/**
 * Sci-Trace Host (The Body)
 * ------------------------
 * This file is the primary orchestrator of the Sci-Trace system.
 * It manages two distinct entry points (Deterministic Slash Commands and 
 * Agentic Conversational Mentions) and routes them to the shared Python Kernel.
 */

const path = require('path');
// Load environment variables from the project root.
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fs = require('fs');
const {
    Client,
    GatewayIntentBits,
    Events,
    REST,
    Routes,
    SlashCommandBuilder,
    AttachmentBuilder,
    EmbedBuilder
} = require('discord.js');

// kernel_bridge manages the spawning and protocol parsing of the Python subprocess.
const { spawnKernel } = require('./kernel-bridge');
// openclaw provides the conversational intelligence layer.
const OpenClawClient = require('./openclaw');

/**
 * LOGGING & OBSERVABILITY
 * -----------------------
 * We maintain an append-only log file to track system performance, 
 * user requests, and kernel failures in production.
 */
const logsDir = path.resolve(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}
const logFile = path.join(logsDir, 'app.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${message}\n`;
    process.stdout.write(logMsg); 
    logStream.write(logMsg);      
}

// System Constants & Capacity Controls
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

// To prevent resource exhaustion on the EC2 instance, we limit 
// the number of active Python processes.
const MAX_CONCURRENT_TRACES = Number.parseInt(process.env.MAX_CONCURRENT_TRACES ?? '2', 10);
const TRACE_CONCURRENCY_LIMIT = Number.isFinite(MAX_CONCURRENT_TRACES) && MAX_CONCURRENT_TRACES > 0
    ? MAX_CONCURRENT_TRACES
    : 2;
const MAX_TRACE_QUEUE_LENGTH = Number.parseInt(process.env.MAX_TRACE_QUEUE_LENGTH ?? '20', 10);
const TRACE_QUEUE_LIMIT = Number.isFinite(MAX_TRACE_QUEUE_LENGTH) && MAX_TRACE_QUEUE_LENGTH > 0
    ? MAX_TRACE_QUEUE_LENGTH
    : 20;

let activeTraces = 0;
const traceQueue = [];

if (!TOKEN || !CLIENT_ID) {
    console.error("CRITICAL ERROR: Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env");
    process.exit(1);
}

// Initialize the OpenClaw conversational client.
const openclaw = new OpenClawClient({
    apiKey: process.env.OPENCLAW_API_KEY,
    baseUrl: process.env.OPENCLAW_BASE_URL,
    agentId: process.env.OPENCLAW_AGENT_ID
});

/**
 * DISCORD CLIENT INITIALIZATION
 * -----------------------------
 * GuildMessages and MessageContent are required for OpenClaw to 
 * 'hear' and 'understand' mentions in the chat.
 */
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

/**
 * SLASH COMMAND REGISTRATION
 * --------------------------
 * Registers the /trace command with Discord's API.
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

async function registerCommands() {
    try {
        logToFile('Started refreshing application (/) commands.');
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

function sanitizeTopic(topic) {
    // Sanitization prevents shell injection by stripping control characters.
    return topic.replace(/[;&|`$(){}\[\]\n\r]/g, '').trim();
}

const http = require('node:http');

// ... (existing imports)

/**
 * UI ABSTRACTION LAYER (DiscordUI)
 * --------------------------------
 * Refactored to support:
 * 1. Interactions (Slash Commands)
 * 2. Messages (Conversational Mentions)
 * 3. Raw Channels (Handoff from OpenClaw)
 */
class DiscordUI {
    constructor(target, channel = null) {
        this.target = target; // interaction, message, or null
        this.channel = channel || target?.channel;
        this.isInteraction = !!target?.editReply;
        this.statusMessage = null;
        this.lastUpdateAt = 0;
    }

    async updateStatus(text) {
        const now = Date.now();
        if (now - this.lastUpdateAt < 1000) return;
        this.lastUpdateAt = now;

        if (this.isInteraction) {
            await this.target.editReply(text).catch(e => logToFile(`UI Interaction Error: ${e.message}`));
        } else {
            if (!this.statusMessage) {
                // If we don't have a status message yet, create one.
                this.statusMessage = await this.channel.send(text).catch(e => logToFile(`UI Channel Error: ${e.message}`));
            } else {
                await this.statusMessage.edit(text).catch(e => logToFile(`UI Edit Error: ${e.message}`));
            }
        }
    }

    async sendFinal(embed, files) {
        if (this.isInteraction) {
            await this.target.followUp({ embeds: [embed], files }).catch(e => logToFile(`UI Interaction Final Error: ${e.message}`));
        } else {
            await this.channel.send({ embeds: [embed], files }).catch(e => logToFile(`UI Channel Final Error: ${e.message}`));
        }
    }

    async sendError(text) {
        const content = `❌ **Error:** ${text}`;
        if (this.isInteraction) {
            await this.target.followUp({ content, ephemeral: true }).catch(e => logToFile(`UI Error: ${e.message}`));
        } else {
            await this.channel.send(content).catch(e => logToFile(`UI Error: ${e.message}`));
        }
    }
}

// ... (enqueueTrace and startTrace remain mostly the same, using the new DiscordUI)

/**
 * PRIVATE HANDOFF SERVER
 * ----------------------
 * Listens on localhost:3000 for trace requests from the OpenClaw Bot.
 */
const HANDOFF_PORT = process.env.HANDOFF_PORT || 3000;

const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/trigger-trace') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { topic, channelId } = JSON.parse(body);
                logToFile(`[HANDOFF REQUEST]: Triggering trace for "${topic}" in channel ${channelId}`);

                if (!channelId || channelId === 'UNKNOWN') {
                    throw new Error("Missing or invalid channel ID in handoff request. Ensure OpenClaw context is being passed.");
                }

                const channel = await client.channels.fetch(channelId);
                if (!channel) throw new Error("Channel not found");

                const ui = new DiscordUI(null, channel);
                
                if (activeTraces >= TRACE_CONCURRENCY_LIMIT) {
                    await enqueueTrace(ui, topic);
                } else {
                    activeTraces += 1;
                    startTrace(ui, topic); // Background execution
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'initiated', topic }));
            } catch (err) {
                logToFile(`HANDOFF ERROR: ${err.message}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(HANDOFF_PORT, '127.0.0.1', () => {
    logToFile(`SYSTEM: Private Handoff Server listening on 127.0.0.1:${HANDOFF_PORT}`);
});

async function enqueueTrace(ui, topic) {
    traceQueue.push({ ui, topic });
    logToFile(`SYSTEM: Trace queued. Position ${traceQueue.length}.`);

    await ui.updateStatus(
        `⏳ Your trace is queued (position ${traceQueue.length}). You will receive updates shortly.`
    );
}

async function startTrace(ui, topic) {
    /**
     * The core execution flow. Spawns the kernel, handles events, 
     * and manages the concurrency slots.
     */
    let traceFinished = false;
    let pendingImagePath = null;

    const finishTrace = (reason) => {
        if (traceFinished) return;
        traceFinished = true;
        activeTraces = Math.max(0, activeTraces - 1);
        logToFile(`SYSTEM: Trace slot released (${reason}).`);

        // Check if there are pending jobs in the queue.
        if (traceQueue.length > 0 && activeTraces < TRACE_CONCURRENCY_LIMIT) {
            const nextJob = traceQueue.shift();
            activeTraces += 1;
            startTrace(nextJob.ui, nextJob.topic).catch(err => {
                logToFile(`QUEUE ERROR: ${err.message}`);
                activeTraces = Math.max(0, activeTraces - 1);
            });
        }
    };

    await ui.updateStatus("🚀 Initializing Python Research Kernel...");

    try {
        // spawnKernel is an asynchronous bridge that parses stdout events.
        const result = await spawnKernel(topic, (event) => {
            if (event.type === 'update') {
                ui.updateStatus(`🔍 ${event.message}`);
            } else if (event.type === 'image') {
                pendingImagePath = event.path;
            } else if (event.type === 'error') {
                ui.sendError(event.message);
            }
        });

        // Construct the final visual report.
        const embed = new EmbedBuilder()
            .setTitle(`Scientific Lineage: ${topic}`)
            .setDescription(result.summary)
            .setColor(0x00AE86) // Success Green
            .setTimestamp()
            .setFooter({ text: 'Sci-Trace | Autonomous Research Agent' });

        const files = [];
        if (pendingImagePath && fs.existsSync(pendingImagePath)) {
            const filename = path.basename(pendingImagePath);
            const attachment = new AttachmentBuilder(pendingImagePath, { name: filename });
            embed.setImage(`attachment://${filename}`);
            files.push(attachment);
        }

        await ui.sendFinal(embed, files);
        finishTrace('complete');
    } catch (err) {
        logToFile(`KERNEL ERROR: ${err.message}`);
        await ui.sendError(err.message);
        finishTrace('error');
    }
}

/**
 * BOT STARTUP
 */
client.once(Events.ClientReady, c => {
    logToFile(`SYSTEM: Logged in as ${c.user.tag}!`);
    registerCommands();
});

/**
 * PATH A: SLASH COMMAND HANDLER
 * ----------------------------
 * Handles deterministic requests triggered via /trace.
 */
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'trace') {
        const rawTopic = interaction.options.getString('topic');
        const topic = sanitizeTopic(rawTopic);
        const ui = new DiscordUI(interaction);

        logToFile(`[USER REQUEST]: ${interaction.user.tag} -> Trace topic: "${topic}"`);

        // Defer immediately to prevent Discord's 3-second timeout.
        await interaction.deferReply();

        if (activeTraces >= TRACE_CONCURRENCY_LIMIT) {
            if (traceQueue.length >= TRACE_QUEUE_LIMIT) {
                await interaction.editReply('⚠️ The queue is full right now. Please try again later.');
                return;
            }
            await enqueueTrace(ui, topic);
            return;
        }

        activeTraces += 1;
        await startTrace(ui, topic);
    }
});

/**
 * PATH B: CONVERSATIONAL (OPENCLAW) HANDLER
 * -----------------------------------------
 * Handles natural language mentions and routes them to the agentic brain.
 */
client.on('messageCreate', async message => {
    // Ignore self or other bots.
    if (message.author.bot) return;
    // Only respond if the bot is explicitly mentioned.
    if (!message.mentions.has(client.user)) return;

    const ui = new DiscordUI(message);
    const content = message.content.replace(`<@!${client.user.id}>`, '').replace(`<@${client.user.id}>`, '').trim();

    if (!content) {
        await message.reply("Hello! How can I help you with your research today?");
        return;
    }

    logToFile(`[OPENCLAW REQUEST]: ${message.author.tag} -> "${content}"`);

    try {
        // OpenClaw's conversational agent evaluates the message.
        // It uses its discovered skills (from extraDirs) to decide how to respond.
        // If a research trace is needed, it will call its native 'exec' tool 
        // as instructed in the 'get-scientific-lineage' SKILL.md.
        const response = await openclaw.chat(
            [{ role: 'user', content: content }],
            [] // Skills are now managed permanently by the Gateway (extraDirs)
        );

        let triggeredTopic = null;

        // Detection: Native Gateway Execution (via 'exec' tool)
        // We look for the handoff script's success message in the agent's response.
        if (response.content && (response.content.includes("research for") || response.content.includes("Lineage trace initiated"))) {
            // Extraction logic: find the topic within quotes or backticks
            const match = response.content.match(/research for ['"`](.*?)['"``]/) || 
                          response.content.match(/lineage of ['"`](.*?)['"``]/i) ||
                          response.content.match(/initiated for ['"`](.*?)['"``]/);
            if (match) {
                triggeredTopic = sanitizeTopic(match[1]);
            }
        }

        if (triggeredTopic) {
            logToFile(`[AGENT DECISION]: Triggering kernel for "${triggeredTopic}" based on conversation.`);
            
            if (activeTraces >= TRACE_CONCURRENCY_LIMIT) {
                await enqueueTrace(ui, triggeredTopic);
            } else {
                activeTraces += 1;
                await startTrace(ui, triggeredTopic);
            }
        } else {
            // Standard conversational response
            let replyContent = response.content || "I'm not sure how to respond to that.";
            
            // Discord has a strict 2000 character limit per message.
            if (replyContent.length > 2000) {
                logToFile(`SYSTEM: Truncating long conversational response (${replyContent.length} chars).`);
                replyContent = replyContent.substring(0, 1900) + "... [Content Truncated due to Discord limits]";
            }
            
            await message.reply(replyContent);
        }
    } catch (err) {
        logToFile(`OPENCLAW ERROR: ${err.message}`);
        await message.reply("⚠️ Sorry, I'm having trouble connecting to my reasoning brain.");
    }
});

/**
 * GLOBAL PROCESS SAFETY
 */
process.on('uncaughtException', (error) => {
    logToFile(`CRITICAL: Uncaught Exception: ${error.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    logToFile(`CRITICAL: Unhandled Rejection: ${reason}`);
});

client.login(TOKEN);
