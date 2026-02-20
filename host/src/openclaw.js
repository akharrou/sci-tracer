/**
 * OpenClaw Integration Wrapper
 * ----------------------------
 * This module facilitates communication with the OpenClaw Gateway.
 * It uses the OpenAI-compatible HTTP API to interact with the conversational agent,
 * allowing Sci-Trace to leverage agentic intent analysis and tool-calling.
 */

const axios = require('axios');

class OpenClawClient {
    /**
     * @param {Object} config
     * @param {string} config.apiKey - Bearer token for OpenClaw Gateway auth.
     * @param {string} [config.baseUrl] - Local or remote Gateway URL.
     * @param {string} [config.agentId] - The specific agent ID to target (default: 'main').
     */
    constructor(config) {
        this.apiKey = config.apiKey;
        // Default port for OpenClaw Gateway is 18789.
        // We point to the host root so that we can use absolute paths for endpoints.
        this.baseUrl = config.baseUrl || 'http://127.0.0.1:18789';
        this.agentId = config.agentId || 'main';
        
        // We use Axios for robust HTTP handling and easy header injection.
        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                // Custom OpenClaw header to specify the target agent.
                'x-openclaw-agent-id': this.agentId
            }
        });
    }

    /**
     * Sends a message to the OpenClaw agent and returns the response.
     * 
     * @param {Array} messages - Standard OpenAI-format messages array.
     * @param {Array} [tools] - Array of tool definitions for intent analysis.
     * @returns {Promise<Object>} - The assistant's message, potentially including tool_calls.
     */
    async chat(messages, tools = []) {
        try {
            const data = {
                // We use the 'openclaw:<id>' model format to ensure the Gateway 
                // routes to the correct agent logic.
                model: `openclaw:${this.agentId}`,
                messages: messages,
                // If tools are provided, OpenClaw will evaluate whether to execute one 
                // based on the user's natural language intent.
                tools: tools.length > 0 ? tools : undefined
            };

            // Using an absolute path ensures the /v1 is never dropped.
            const response = await this.client.post('/v1/chat/completions', data);
            
            // Return the first choice (Standard OpenAI API structure).
            return response.data.choices[0].message;
        } catch (error) {
            /**
             * ERROR HANDLING
             * We log the specific error response from the Gateway (e.g., 401 Unauthorized,
             * or 500 Agent Crash) to help with remote debugging.
             */
            console.error(`[OpenClaw]: Request to ${this.baseUrl}/v1/chat/completions Failed: ${error.message}`);
            if (error.response) {
                console.error(`[OpenClaw]: Status: ${error.response.status} | Data: ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    }
}

module.exports = OpenClawClient;
