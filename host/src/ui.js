/**
 * UI Abstraction Layer for Sci-Trace
 * ---------------------------------
 * This module provides platform-specific adapters (Discord, Slack)
 * for streaming real-time research updates and final reports.
 * 
 * Includes chunking logic to handle long narrative summaries across platforms.
 */

const fs = require('fs');
const path = require('path');
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');

/**
 * CHUNKING UTILITY
 * Splits a long string into smaller chunks without cutting off words in the middle.
 */
function chunkString(str, maxLength) {
    if (!str) return [];
    if (str.length <= maxLength) return [str];

    const chunks = [];
    let currentPos = 0;

    while (currentPos < str.length) {
        let endPos = currentPos + maxLength;
        
        if (endPos < str.length) {
            // Find the last newline or space to avoid splitting a word
            let lastSpace = str.lastIndexOf('\n', endPos);
            if (lastSpace <= currentPos) {
                lastSpace = str.lastIndexOf(' ', endPos);
            }
            
            if (lastSpace > currentPos) {
                endPos = lastSpace;
            }
        }
        
        chunks.push(str.substring(currentPos, endPos).trim());
        currentPos = endPos;
    }
    
    return chunks;
}

class BaseUI {
    constructor() {
        this.lastUpdateAt = 0;
        this.statusMessage = null;
    }

    async updateStatus(text) { throw new Error("Not implemented"); }
    async sendFinal(data, files) { throw new Error("Not implemented"); }
    async sendError(text) { throw new Error("Not implemented"); }
}

/**
 * DISCORD ADAPTER
 */
class DiscordUI extends BaseUI {
    constructor(target, channel = null) {
        super();
        this.target = target; // interaction, message, or null
        this.channel = channel || target?.channel;
        this.isInteraction = !!target?.editReply;
    }

    async updateStatus(text) {
        const now = Date.now();
        if (now - this.lastUpdateAt < 1000) return;
        this.lastUpdateAt = now;

        const content = text;
        if (this.isInteraction) {
            await this.target.editReply(content).catch(e => console.error(`Discord UI Error: ${e.message}`));
        } else {
            if (!this.statusMessage) {
                this.statusMessage = await this.channel.send(content).catch(e => console.error(`Discord UI Error: ${e.message}`));
            } else {
                await this.statusMessage.edit(content).catch(e => console.error(`Discord UI Error: ${e.message}`));
            }
        }
    }

    async sendFinal(summary, topic, files = []) {
        // Discord Embed description limit is 4096. 
        // We use a safer limit of 3500 to leave room for headers/formatting.
        const chunks = chunkString(summary, 3500);
        const embeds = [];

        for (let i = 0; i < chunks.length; i++) {
            const embed = new EmbedBuilder()
                .setTitle(i === 0 ? `Scientific Lineage: ${topic}` : `Scientific Lineage: ${topic} (Continued)`)
                .setDescription(chunks[i])
                .setColor(0x00AE86)
                .setTimestamp()
                .setFooter({ text: `Sci-Trace | Part ${i + 1}/${chunks.length}` });
            
            // Attach image only to the FIRST embed
            if (i === 0 && files.length > 0) {
                const filename = path.basename(files[0].attachment);
                embed.setImage(`attachment://${filename}`);
            }
            
            embeds.push(embed);
        }

        // Discord allows up to 10 embeds per message.
        // If we exceed this, we send in batches.
        const batchSize = 5;
        for (let i = 0; i < embeds.length; i += batchSize) {
            const currentBatch = embeds.slice(i, i + batchSize);
            const currentFiles = (i === 0) ? files : [];

            if (this.isInteraction) {
                await this.target.followUp({ embeds: currentBatch, files: currentFiles }).catch(e => console.error(`Discord Final Error: ${e.message}`));
            } else {
                await this.channel.send({ embeds: currentBatch, files: currentFiles }).catch(e => console.error(`Discord Final Error: ${e.message}`));
            }
        }
    }

    async sendError(text) {
        const content = `❌ **Error:** ${text}`;
        if (this.isInteraction) {
            await this.target.followUp({ content, ephemeral: true }).catch(e => console.error(`Discord Error: ${e.message}`));
        } else {
            await this.channel.send(content).catch(e => console.error(`Discord Error: ${e.message}`));
        }
    }
}

/**
 * SLACK ADAPTER
 */
class SlackUI extends BaseUI {
    constructor(client, channelId, threadTs = null) {
        super();
        this.client = client;
        this.channelId = channelId;
        this.threadTs = threadTs;
    }

    async updateStatus(text) {
        const now = Date.now();
        if (now - this.lastUpdateAt < 1500) return; // Slack has stricter rate limits
        this.lastUpdateAt = now;

        const content = text;
        if (!this.statusMessage) {
            const result = await this.client.chat.postMessage({
                channel: this.channelId,
                thread_ts: this.threadTs,
                text: content
            }).catch(e => console.error(`Slack UI Error: ${e.message}`));
            if (result) this.statusMessage = result;
        } else {
            await this.client.chat.update({
                channel: this.channelId,
                ts: this.statusMessage.ts,
                text: content
            }).catch(e => console.error(`Slack UI Edit Error: ${e.message}`));
        }
    }

    async sendFinal(summary, topic, files = []) {
        // Slack text block limit is 3000 characters.
        const chunks = chunkString(summary, 2800);
        
        for (let i = 0; i < chunks.length; i++) {
            const titlePrefix = i === 0 ? `*Scientific Lineage: ${topic}*\n\n` : `*Scientific Lineage: ${topic} (Continued)*\n\n`;
            
            await this.client.chat.postMessage({
                channel: this.channelId,
                thread_ts: this.threadTs,
                text: `${titlePrefix}${chunks[i]}`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `${titlePrefix}${chunks[i]}`
                        }
                    }
                ]
            }).catch(e => console.error(`Slack Final Text Error: ${e.message}`));
        }

        // Upload the artifact if it exists (only once)
        if (files && files.length > 0) {
            const file = files[0];
            const filePath = file.attachment;

            await this.client.files.uploadV2({
                channel_id: this.channelId,
                thread_ts: this.threadTs,
                file: fs.createReadStream(filePath),
                filename: path.basename(filePath),
                initial_comment: `Visual lineage map for ${topic}`
            }).catch(e => console.error(`Slack File Upload Error: ${e.message}`));
        }
    }

    async sendError(text) {
        await this.client.chat.postMessage({
            channel: this.channelId,
            thread_ts: this.threadTs,
            text: `❌ *Error:* ${text}`
        }).catch(e => console.error(`Slack Error Msg Error: ${e.message}`));
    }
}

module.exports = { DiscordUI, SlackUI };
