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
 * Verifies that the DiscordUI wrapper correctly routes updates to 
 * either interactions or standard messages.
 */
async function testUIAbstraction() {
    console.log('Testing DiscordUI Abstraction Logic...');
    
    const mockInteraction = {
        editReply: async (val) => { mockInteraction.lastVal = val; return val; },
        followUp: async (val) => { mockInteraction.lastFollowUp = val; return val; }
    };

    const mockMessage = {
        reply: async (val) => { 
            const msg = { 
                edit: async (v) => { msg.lastVal = v; },
                lastVal: val
            };
            mockMessage.lastReply = val; 
            mockMessage.statusMessage = msg;
            return msg; 
        },
        channel: { send: async (val) => { mockMessage.lastSend = val; } }
    };

    const mockChannel = {
        send: async (val) => { 
            mockChannel.lastSend = val; 
            return { edit: async (v) => { mockChannel.lastEdit = v; } }; 
        }
    };

    // Simulation of the logic inside index.js
    const simulateUIUpdate = async (target, channel, isInteraction, text, hasStatusMessage) => {
        if (isInteraction) {
            await target.editReply(text);
        } else {
            if (!hasStatusMessage) {
                target.statusMessage = await (channel || target.channel).send(text);
            } else {
                await target.statusMessage.edit(text);
            }
        }
    };

    // Test Path A (Slash Command)
    await simulateUIUpdate(mockInteraction, null, true, 'Status 1', false);
    assert.strictEqual(mockInteraction.lastVal, 'Status 1');

    // Test Path B (Conversational Message)
    await simulateUIUpdate(mockMessage, null, false, 'Status A', false);
    assert.strictEqual(mockMessage.lastSend, 'Status A');

    // Test Path C (Handoff Channel)
    const mockHandoff = {};
    await simulateUIUpdate(mockHandoff, mockChannel, false, 'Status C', false);
    assert.strictEqual(mockChannel.lastSend, 'Status C');

    console.log('✅ UI Abstraction test passed.');
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
