/**
 * Sci-Trace Host Multi-Platform UI Tests
 * ------------------------------------
 * Verifies that the UI abstraction layer correctly handles Discord and Slack 
 * platforms, including status updates and final reports.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { DiscordUI, SlackUI } = require('../src/ui');

// Mocking Dependencies
class MockDiscordChannel {
    constructor() {
        this.sentMessages = [];
    }
    async send(content) {
        const msg = {
            content,
            editedContent: null,
            async edit(newContent) { this.editedContent = newContent; }
        };
        this.sentMessages.push(msg);
        return msg;
    }
}

class MockSlackClient {
    constructor() {
        this.posts = [];
        this.updates = [];
        this.uploads = [];
    }
    get chat() {
        return {
            postMessage: async (payload) => {
                this.posts.push(payload);
                return { ts: '123.456' };
            },
            update: async (payload) => {
                this.updates.push(payload);
                return { ok: true };
            }
        };
    }
    get files() {
        return {
            uploadV2: async (payload) => {
                this.uploads.push(payload);
                return { ok: true };
            }
        };
    }
}

/**
 * Test: Discord UI Adapter
 */
async function testDiscordUI() {
    console.log('Testing Discord UI Adapter...');
    const channel = new MockDiscordChannel();
    const ui = new DiscordUI(null, channel);

    // 1. Initial Status
    await ui.updateStatus('Finding root paper...');
    assert.strictEqual(channel.sentMessages.length, 1);
    assert.strictEqual(channel.sentMessages[0].content, 'Finding root paper...');

    // 2. Status Update (Edit)
    // Wait for >1s to bypass rate limiter in ui.js
    ui.lastUpdateAt = 0; 
    await ui.updateStatus('Searching references...');
    assert.strictEqual(channel.sentMessages[0].editedContent, 'Searching references...');

    // 3. Final Report
    const summary = 'This is the summary';
    const topic = 'Self-RAG';
    await ui.sendFinal(summary, topic, []);
    assert.strictEqual(channel.sentMessages.length, 2);
    
    const sentEmbed = channel.sentMessages[1].content.embeds[0].data;
    assert.strictEqual(sentEmbed.title, 'Scientific Lineage: Self-RAG');
    assert.strictEqual(sentEmbed.description, summary);

    console.log('✅ Discord UI test passed.');
}

/**
 * Test: Slack UI Adapter
 */
async function testSlackUI() {
    console.log('Testing Slack UI Adapter...');
    const client = new MockSlackClient();
    const ui = new SlackUI(client, 'C123', 'thread-456');

    // 1. Initial Status
    await ui.updateStatus('Initializing...');
    assert.strictEqual(client.posts.length, 1);
    assert.strictEqual(client.posts[0].text, 'Initializing...');
    assert.strictEqual(client.posts[0].thread_ts, 'thread-456');

    // 2. Status Update (Edit)
    ui.lastUpdateAt = 0;
    await ui.updateStatus('Researching...');
    assert.strictEqual(client.updates.length, 1);
    assert.strictEqual(client.updates[0].text, 'Researching...');
    assert.strictEqual(client.updates[0].ts, '123.456');

    // 3. Final Report
    const summary = 'The root is found.';
    const topic = 'Attention';
    await ui.sendFinal(summary, topic, []);
    assert.strictEqual(client.posts.length, 2);
    assert.ok(client.posts[1].text.includes('Attention'));
    assert.ok(client.posts[1].text.includes('The root is found.'));

    console.log('✅ Slack UI test passed.');
}

async function runTests() {
    try {
        await testDiscordUI();
        await testSlackUI();
        console.log('\n🎉 Multi-Platform UI Tests Passed!');
    } catch (err) {
        console.error('\n❌ Tests Failed:');
        console.error(err);
        process.exit(1);
    }
}

runTests();
