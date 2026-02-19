const path = require('path');
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
const { spawnKernel } = require('./bridge');

// Ensure logs directory exists
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

const TOKEN = process.env.DISCORD_TOKEN;
// ... (rest of configuration)

client.once('ready', () => {
    logToFile(`Logged in as ${client.user.tag}!`);
    registerCommands();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'trace') {
        const rawTopic = interaction.options.getString('topic');
        const topic = sanitizeTopic(rawTopic);
        
        logToFile(`[Command]: User ${interaction.user.tag} requested trace for: ${topic}`);

        await interaction.deferReply();
// ... (rest of command handler)


        let lastMessage = "🚀 Initializing kernel...";
        await interaction.editReply(lastMessage);

        spawnKernel(
            topic,
            async (update) => {
                lastMessage = `🔍 ${update}`;
                await interaction.editReply(lastMessage).catch(console.error);
            },
            async (imagePath) => {
                const attachment = new AttachmentBuilder(imagePath);
                await interaction.followUp({ files: [attachment] }).catch(console.error);
            },
            async (final) => {
                const embed = new EmbedBuilder()
                    .setTitle(`Lineage Trace: ${topic}`)
                    .setDescription(final)
                    .setColor(0x00AE86)
                    .setTimestamp();
                await interaction.followUp({ embeds: [embed] }).catch(console.error);
            },
            async (error) => {
                await interaction.followUp({ content: `❌ Error: ${error}`, ephemeral: true }).catch(console.error);
            }
        );
    }
});

// --- Error Handling ---
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

client.login(TOKEN);
