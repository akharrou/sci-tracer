#!/usr/bin/env python3
import sys
import json
import os
import requests
import time

"""
Sci-Trace Handoff Wrapper (Multi-Platform v2.2)
------------------------------------
This script is the 'Bridge' executed by the OpenClaw Gateway.
It captures the conversation context (Platform, Channel ID, Thread TS) 
and hands off the research task to the Node.js Host process.
"""

# Default handoff endpoint for the local Node.js bot
HANDOFF_URL = os.environ.get("SCI_TRACE_HANDOFF_URL", "http://127.0.0.1:18788/trigger-trace")

def log(msg):
    """Logs to stderr so it shows up in OpenClaw gateway logs but not stdout."""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"[{timestamp}] [Handoff]: {msg}\n")
    sys.stderr.flush()

def handoff_to_host(topic, channel_id, platform, thread_ts=None):
    log(f"Initiating handoff for topic='{topic}' on platform='{platform}' channel='{channel_id}'")

    payload = {
        "topic": topic,
        "channelId": channel_id,
        "platform": platform,
        "threadTs": thread_ts,
        "triggeredBy": "OpenClaw-Agent"
    }

    try:
        response = requests.post(HANDOFF_URL, json=payload, timeout=10)

        if response.status_code == 200:
            log("Handoff successful.")
            print(json.dumps({
                "ok": True,
                "topic": topic,
                "message": f"Successfully handed off research for '{topic}' to the Sci-Trace Body. Updates will follow in this channel.",
                "handoff_status": "accepted"
            }))
        else:
            log(f"Handoff failed with status {response.status_code}: {response.text}")
            print(json.dumps({
                "ok": False,
                "error": f"Node.js Host rejected the request: {response.text}"
            }))

    except requests.exceptions.ConnectionError:
        log("Connection error: Is the Node.js Host running on port 3000?")
        print(json.dumps({
            "ok": False,
            "error": "Could not connect to the Sci-Trace Host. Ensure 'pm2 restart sci-trace-host' has been run."
        }))
    except Exception as e:
        log(f"Unexpected error: {str(e)}")
        print(json.dumps({
            "ok": False,
            "error": f"Internal handoff error: {str(e)}"
        }))

if __name__ == "__main__":
    # 1. Capture Arguments (Topic) FIRST to avoid NameErrors
    topic = "Unknown"
    if len(sys.argv) > 1:
        try:
            arg_data = sys.argv[1]
            parsed_args = json.loads(arg_data)
            topic = parsed_args.get("topic", topic)
        except json.JSONDecodeError:
            topic = sys.argv[1]

    # 2. Capture Environment Variables (Context)
    raw_to = os.environ.get("OPENCLAW_MESSAGE_TO", "")
    channel_id = os.environ.get("OPENCLAW_MESSAGE_CHANNEL_ID") or os.environ.get("CHANNEL_ID")
    thread_ts = os.environ.get("OPENCLAW_MESSAGE_THREAD_TS")
    platform = os.environ.get("OPENCLAW_PLATFORM", "discord").lower()

    # 3. Advanced Parsing for Slack/Discord Routing
    if ":" in raw_to:
        parts = raw_to.split(":", 1)
        inferred_platform = parts[0].lower()
        if inferred_platform in ["slack", "discord"]:
            platform = inferred_platform
            if not channel_id or channel_id == "UNKNOWN":
                channel_id = parts[1]

    # 4. Final Sanitization
    if channel_id and "channel:" in channel_id:
        channel_id = channel_id.replace("channel:", "")

    # 5. Handle Missing Context (Conversational Trigger)
    if not channel_id or channel_id in ["UNKNOWN", "null", "None"]:
        log("No valid Channel ID found. Skipping POST to Host (Host will handle via response parsing).")
        print(json.dumps({
            "ok": True,
            "topic": topic,
            "message": f"[TRACE: {topic}] Lineage trace initiated for '{topic}'. Analytical results will follow.",
            "handoff_status": "delegated_to_host"
        }))
        sys.exit(0)

    # 6. Execute Handoff
    handoff_to_host(topic, channel_id, platform, thread_ts)
