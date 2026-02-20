/**
 * Sci-Trace Host v2 Unit Tests
 * ----------------------------
 * Tests the core logic of the host layer without requiring a live Discord connection.
 */

const assert = require('node:assert');
const { spawnKernel } = require('../src/kernel-bridge');
const OpenClawClient = require('../src/openclaw');
const fs = require('fs');
const path = require('path');

// Mock child_process for bridge testing
const { EventEmitter } = require('node:events');
const child_process = require('child_process');

/**
 * Test 1: Kernel Bridge Protocol Parsing
 * Verifies that the bridge correctly parses UI tags from Python stdout
 * and handles multi-line unescaping.
 */
async function testBridgeParsing() {
    console.log('Testing Kernel Bridge Protocol Parsing...');

    const originalSpawn = child_process.spawn;
    child_process.spawn = (cmd, args) => {
        const mockProc = new EventEmitter();
        mockProc.stdout = new EventEmitter();
        mockProc.stderr = new EventEmitter();
        
        setTimeout(() => {
            mockProc.stdout.emit('data', Buffer.from('[UI:UPDATE] Step 1\n'));
            mockProc.stdout.emit('data', Buffer.from('[UI:IMAGE] /tmp/test.png\n'));
            // Send escaped multi-line summary (literal backslash then n)
            mockProc.stdout.emit('data', Buffer.from('[UI:FINAL] Line 1\\nLine 2\n'));
            mockProc.emit('close', 0);
        }, 10);

        return mockProc;
    };

    const events = [];
    const result = await spawnKernel('test-topic', (ev) => {
        events.push(ev);
    });

    assert.strictEqual(events.length, 3, `Expected 3 events, got ${events.length}`);
    assert.strictEqual(events[0].type, 'update');
    assert.strictEqual(events[1].type, 'image');
    assert.strictEqual(events[2].type, 'final');
    
    // Verify unescaping logic (Task 10)
    assert.strictEqual(events[2].summary, 'Line 1\nLine 2');
    assert.strictEqual(result.summary, 'Line 1\nLine 2');

    child_process.spawn = originalSpawn;
    console.log('✅ Bridge parsing test passed.');
}

/**
 * Test 2: UI Abstraction Logic
 * Verifies that the new platform-specific UI classes correctly route 
 * updates to either Discord or Slack.
 */
const { DiscordUI, SlackUI } = require('../src/ui');

async function testUIAbstraction() {
    console.log('Testing Discord/Slack UI Abstractions...');
    
    // 1. Test DiscordUI
    const mockChannel = {
        sent: [],
        async send(content) { 
            const msg = { content, async edit(c) { msg.content = c; } };
            this.sent.push(msg); 
            return msg; 
        }
    };
    const discordUI = new DiscordUI(null, mockChannel);
    await discordUI.updateStatus('Discord-1');
    assert.strictEqual(mockChannel.sent[0].content, 'Discord-1');
    
    discordUI.lastUpdateAt = 0; // Reset rate-limiter
    await discordUI.updateStatus('Discord-2');
    assert.strictEqual(mockChannel.sent[0].content, 'Discord-2');

    // 2. Test SlackUI
    const mockSlackClient = {
        posts: [],
        async postMessage(payload) {
            this.posts.push(payload);
            return { ts: '123' };
        },
        async update(payload) {
            this.posts[0].text = payload.text;
            return { ok: true };
        }
    };
    const slackUI = new SlackUI({ chat: mockSlackClient }, 'C123');
    await slackUI.updateStatus('Slack-1');
    assert.strictEqual(mockSlackClient.posts[0].text, 'Slack-1');

    slackUI.lastUpdateAt = 0; // Reset rate-limiter
    await slackUI.updateStatus('Slack-2');
    assert.strictEqual(mockSlackClient.posts[0].text, 'Slack-2');

    console.log('✅ UI Abstraction tests passed.');
}

/**
 * Test 3: OpenClaw Client Logic
 * Verifies that the client correctly formats requests for the OpenClaw Gateway.
 */
async function testOpenClawClient() {
    console.log('Testing OpenClaw Client Logic...');

    const client = new OpenClawClient({ apiKey: 'test-key' });
    
    // Mock axios instance behavior
    client.client.post = async (url, data) => {
        // Updated expectation to match v2 absolute path
        assert.strictEqual(url, '/v1/chat/completions');
        assert.strictEqual(data.model, 'openclaw:main');
        
        return {
            data: {
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'Hello, I am OpenClaw',
                        tool_calls: data.tools ? [{ function: { name: 'get-scientific-lineage' } }] : undefined
                    }
                }]
            }
        };
    };

    // Chat test
    const response = await client.chat([{ role: 'user', content: 'hi' }]);
    assert.strictEqual(response.content, 'Hello, I am OpenClaw');

    // Tool call test
    const toolResponse = await client.chat([{ role: 'user', content: 'trace X' }], [{ name: 'get-scientific-lineage' }]);
    assert.strictEqual(toolResponse.tool_calls[0].function.name, 'get-scientific-lineage');

    console.log('✅ OpenClaw Client test passed.');
}

async function runAll() {
    try {
        await testBridgeParsing();
        await testUIAbstraction();
        await testOpenClawClient();
        console.log('\n🎉 All Host Unit Tests Passed Successfully!');
    } catch (err) {
        console.error('\n❌ Test Suite Failed:');
        console.error(err);
        process.exit(1);
    }
}

runAll();
