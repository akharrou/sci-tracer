/**
 * Sci-Trace Host (The Body)
 * ------------------------
 * This file is the primary orchestrator of the Sci-Trace system.
 * It manages multiple entry points (Discord, Slack, OpenClaw) 
 * and routes them to the shared Python Kernel.
 */

const path = require('path');
// Load environment variables from the project root.
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fs = require('fs');
const http = require('node:http');
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
const { App } = require('@slack/bolt');

// UI adapters for multi-platform support.
const { DiscordUI, SlackUI } = require('./ui');
// kernel_bridge manages the spawning and protocol parsing of the Python subprocess.
const { spawnKernel } = require('./kernel-bridge');
// openclaw provides the conversational intelligence layer.
const OpenClawClient = require('./openclaw');

/**
 * LOGGING & OBSERVABILITY
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
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

const MAX_CONCURRENT_TRACES = Number.parseInt(process.env.MAX_CONCURRENT_TRACES ?? '2', 10);
const TRACE_CONCURRENCY_LIMIT = Math.max(1, MAX_CONCURRENT_TRACES);
const MAX_TRACE_QUEUE_LENGTH = Number.parseInt(process.env.MAX_TRACE_QUEUE_LENGTH ?? '20', 10);
const TRACE_QUEUE_LIMIT = Math.max(1, MAX_TRACE_QUEUE_LENGTH);

let activeTraces = 0;
const traceQueue = [];

// Initialize OpenClaw
const openclaw = new OpenClawClient({
    apiKey: process.env.OPENCLAW_API_KEY,
    baseUrl: process.env.OPENCLAW_BASE_URL,
    agentId: process.env.OPENCLAW_AGENT_ID
});

/**
 * DISCORD CLIENT INITIALIZATION
 */
let discordClient = null;
if (DISCORD_TOKEN && DISCORD_CLIENT_ID) {
    discordClient = new Client({ 
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ] 
    });

    const discordCommands = [
        new SlashCommandBuilder()
            .setName('trace')
            .setDescription('Trace the intellectual lineage of a scientific topic')
            .addStringOption(option =>
                option.setName('topic')
                    .setDescription('The topic or paper to trace (e.g., Self-RAG)')
                    .setRequired(true))
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    async function registerDiscordCommands() {
        try {
            logToFile('Refreshing Discord (/) commands.');
            if (DISCORD_GUILD_ID) {
                await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: discordCommands });
            } else {
                await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: discordCommands });
            }
            logToFile('Successfully reloaded Discord (/) commands.');
        } catch (error) {
            logToFile(`ERROR: Discord Command registration failed: ${error.message}`);
        }
    }

    discordClient.once(Events.ClientReady, c => {
        logToFile(`SYSTEM: Discord logged in as ${c.user.tag}!`);
        registerDiscordCommands();
    });

    discordClient.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName === 'trace') {
            const topic = sanitizeTopic(interaction.options.getString('topic'));
            const ui = new DiscordUI(interaction);
            await handleTraceRequest(ui, topic, `Discord:${interaction.user.tag}`, () => interaction.deferReply());
        }
    });

    discordClient.on('messageCreate', async message => {
        if (message.author.bot || !message.mentions.has(discordClient.user)) return;
        const content = message.content.replace(`<@!${discordClient.user.id}>`, '').replace(`<@${discordClient.user.id}>`, '').trim();
        if (!content) return message.reply("How can I help you with your research?");
        
        const ui = new DiscordUI(message);
        await handleConversationalRequest(ui, content, `Discord:${message.author.tag}`);
    });

    discordClient.login(DISCORD_TOKEN).catch(e => logToFile(`Discord Login Error: ${e.message}`));
}

/**
 * SLACK CLIENT INITIALIZATION
 */
let slackApp = null;
if (SLACK_BOT_TOKEN && SLACK_SIGNING_SECRET) {
    slackApp = new App({
        token: SLACK_BOT_TOKEN,
        signingSecret: SLACK_SIGNING_SECRET,
        socketMode: !!SLACK_APP_TOKEN,
        appToken: SLACK_APP_TOKEN
    });

    slackApp.command('/trace', async ({ command, ack, say, client }) => {
        await ack();
        const topic = sanitizeTopic(command.text);
        if (!topic) return say("Please provide a topic. Usage: `/trace Self-RAG`.");
        
        const ui = new SlackUI(client, command.channel_id);
        await handleTraceRequest(ui, topic, `Slack:${command.user_name}`);
    });

    slackApp.event('app_mention', async ({ event, say, client }) => {
        const content = event.text.replace(/<@.*?>/g, '').trim();
        logToFile(`[SLACK MENTION EVENT]: User=${event.user} Channel=${event.channel} Text="${event.text}" Content="${content}"`);
        if (!content) return say("I'm listening. What shall we research?");

        const ui = new SlackUI(client, event.channel, event.thread_ts || event.ts);
        await handleConversationalRequest(ui, content, `Slack:${event.user}`);
    });

    slackApp.error(async (error) => {
        logToFile(`SLACK APP ERROR: ${error.message}`);
    });

    slackApp.message(async ({ message, client, say }) => {
        // Skip bot messages
        if (message.bot_id || message.subtype) return;

        const isDM = message.channel && message.channel.startsWith('D');
        logToFile(`[SLACK MESSAGE EVENT]: User=${message.user} Channel=${message.channel} DM=${isDM} Text="${message.text}"`);

        // If it's a DM, handle it directly
        if (isDM) {
            const ui = new SlackUI(client, message.channel, message.thread_ts || message.ts);
            await handleConversationalRequest(ui, message.text, `Slack:DM:${message.user}`);
        }
        // If it's in a channel, we only handle it if it wasn't caught by app_mention 
        // but still looks like a mention (e.g., text contains the bot's name or ID)
        else if (message.text && (message.text.includes(`<@${client.botId}>`) || message.text.toLowerCase().includes('research assistant'))) {
            logToFile(`[SLACK PSEUDO-MENTION]: Handling channel message as mention.`);
            const ui = new SlackUI(client, message.channel, message.thread_ts || message.ts);
            const cleanText = message.text.replace(/<@.*?>/g, '').replace(/research assistant/gi, '').trim();
            await handleConversationalRequest(ui, cleanText, `Slack:Channel:${message.user}`);
        }
    });

    slackApp.start().then(() => logToFile('SYSTEM: Slack Bolt app is running!')).catch(e => logToFile(`Slack Start Error: ${e.message}`));
}

/**
 * COMMON HANDLERS
 */
function sanitizeTopic(topic) {
    return (topic || '').replace(/[;&|`$(){}\[\]\n\r]/g, '').trim();
}

async function handleTraceRequest(ui, topic, userLabel, preAction = null) {
    logToFile(`[TRACE REQUEST]: ${userLabel} -> Topic: "${topic}"`);
    if (preAction) await preAction();

    if (activeTraces >= TRACE_CONCURRENCY_LIMIT) {
        if (traceQueue.length >= TRACE_QUEUE_LIMIT) {
            return ui.sendError("The research queue is full. Please try again later.");
        }
        await enqueueTrace(ui, topic);
        return;
    }

    activeTraces += 1;
    startTrace(ui, topic);
}

async function handleConversationalRequest(ui, content, userLabel) {
    logToFile(`[CONVERSATION]: ${userLabel} -> "${content}"`);
    try {
        const response = await openclaw.chat([{ role: 'user', content: content }], []);
        let triggeredTopic = null;

        logToFile(`[AGENT RESPONSE]: ${response.content}`);

        if (response.content) {
            // Priority: Strict Tag Detection [TRACE: Topic]
            const tagMatch = response.content.match(/\[TRACE: (.*?)\]/i);
            if (tagMatch) {
                triggeredTopic = sanitizeTopic(tagMatch[1]);
            } 
            // Fallback: Legacy Phrasing (if tag is somehow missed)
            else if (response.content.toLowerCase().includes("research for") || response.content.toLowerCase().includes("lineage")) {
                const match = response.content.match(/research for ['"`]?(.*?)['"`]?/i) || 
                              response.content.match(/lineage of ['"`]?(.*?)['"`]?/i) ||
                              response.content.match(/trace for ['"`]?(.*?)['"`]?/i);
                if (match) triggeredTopic = sanitizeTopic(match[1].split('.')[0].split('\n')[0]);
            }
        }

        if (triggeredTopic) {
            logToFile(`[AGENT DECISION]: Triggering kernel for "${triggeredTopic}"`);
            await handleTraceRequest(ui, triggeredTopic, `${userLabel} (Agent)`);
        } else {
            // Clean up internal tags if they exist
            let reply = (response.content || "I'm not sure how to assist with that.").replace(/\[TRACE: (.*?)\]/gi, '').trim();
            
            // Fallback Detection: If the agent mentioned lineage/trace but didn't match the regex
            if (reply.toLowerCase().includes('lineage') || reply.toLowerCase().includes('trace')) {
                // If the user's content was just a few words, assume the last word(s) are the topic
                const words = content.split(' ');
                const possibleTopic = words.length > 2 ? words.slice(-2).join(' ').replace(/[?]/g, '') : words[words.length - 1].replace(/[?]/g, '');
                logToFile(`[AGENT FALLBACK]: Attempting to infer topic from query: "${possibleTopic}"`);
                await handleTraceRequest(ui, possibleTopic, `${userLabel} (Inferred)`);
            }

            if (reply.length > 2000) reply = reply.substring(0, 1900) + "... [Truncated]";
            
            // Use native platform reply instead of status update for standard chat
            if (ui.target && ui.target.reply) {
                await ui.target.reply(reply).catch(e => logToFile(`Reply Error: ${e.message}`));
            } else if (ui.client && ui.client.chat) {
                await ui.client.chat.postMessage({
                    channel: ui.channelId,
                    thread_ts: ui.threadTs,
                    text: reply
                }).catch(e => logToFile(`Slack Reply Error: ${e.message}`));
            } else {
                await ui.updateStatus(reply);
            }
        }
    } catch (err) {
        logToFile(`AGENT ERROR: ${err.message}`);
        await ui.sendError("I'm having trouble connecting to my reasoning brain.");
    }
}

/**
 * PRIVATE HANDOFF SERVER
 */
const HANDOFF_PORT = process.env.HANDOFF_PORT || 18788; // Changed from 3000 to avoid conflict with Slack Bolt
const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/trigger-trace') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { topic, channelId, platform, threadTs } = JSON.parse(body);
                logToFile(`[HANDOFF REQUEST]: Topic="${topic}" Platform=${platform} Channel=${channelId}`);

                let ui = null;
                if (platform === 'slack' && slackApp) {
                    ui = new SlackUI(slackApp.client, channelId, threadTs);
                } else if (discordClient) {
                    const channel = await discordClient.channels.fetch(channelId);
                    if (channel) ui = new DiscordUI(null, channel);
                }

                if (!ui) throw new Error(`Could not initialize UI for platform ${platform}`);

                await handleTraceRequest(ui, topic, `Handoff:${platform}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'initiated' }));
            } catch (err) {
                logToFile(`HANDOFF ERROR: ${err.message}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404).end();
    }
});
server.listen(HANDOFF_PORT, '127.0.0.1', () => logToFile(`SYSTEM: Private Handoff Server listening at 127.0.0.1:${HANDOFF_PORT}`));

/**
 * KERNEL EXECUTION ENGINE
 */
async function enqueueTrace(ui, topic) {
    traceQueue.push({ ui, topic });
    logToFile(`SYSTEM: Trace queued. Pos: ${traceQueue.length}.`);
    await ui.updateStatus(`⏳ Your trace is queued (position ${traceQueue.length}).`);
}

async function startTrace(ui, topic) {
    let traceFinished = false;
    let pendingImagePath = null;

    const finishTrace = () => {
        if (traceFinished) return;
        traceFinished = true;
        activeTraces = Math.max(0, activeTraces - 1);
        if (traceQueue.length > 0 && activeTraces < TRACE_CONCURRENCY_LIMIT) {
            const next = traceQueue.shift();
            activeTraces += 1;
            startTrace(next.ui, next.topic);
        }
    };

    await ui.updateStatus("🚀 Initializing Research Kernel...");
    try {
        const result = await spawnKernel(topic, (event) => {
            if (event.type === 'update') ui.updateStatus(`🔍 ${event.message}`);
            else if (event.type === 'image') pendingImagePath = event.path;
            else if (event.type === 'error') ui.sendError(event.message);
        });

        const files = [];
        if (pendingImagePath && fs.existsSync(pendingImagePath)) {
            files.push(new AttachmentBuilder(pendingImagePath, { name: path.basename(pendingImagePath) }));
        }

        const summary = result.summary || "Research analysis complete. No specific methodological summary was generated.";
        await ui.sendFinal(summary, topic, files);
        finishTrace();
    } catch (err) {
        logToFile(`KERNEL ERROR: ${err.message}`);
        await ui.sendError(err.message);
        finishTrace();
    }
}

process.on('uncaughtException', (e) => logToFile(`CRITICAL ERROR: ${e.message}`));
process.on('unhandledRejection', (r) => logToFile(`CRITICAL REJECTION: ${r}`));
