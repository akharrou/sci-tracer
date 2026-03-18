# Sci-Trace: Autonomous Scientific Lineage Mapper

**Table of Contents**

- [Gist](#sci-trace-autonomous-scientific-lineage-mapper)
- [Demos](#demos)
- [System Architecture: The Host-OpenClaw-Kernel Pattern](#system-architecture-the-host-openclaw-kernel-pattern)
- [Full Request Lifecycle](#full-request-lifecycle)
  - [Kernel Logic: LangGraph State Machine](#kernel-logic-langgraph-state-machine)
- [Setup \& Installation](#setup--installation)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Environment Configuration](#2-environment-configuration)
  - [3. Installation](#3-installation)
  - [4. Running the Trace](#4-running-the-trace)
- [Cloud Infrastructure \& Deployment](#cloud-infrastructure--deployment)
  - [Provisioning (Terraform)](#provisioning-terraform)
  - [Deployment](#deployment)
  - [Process Management (PM2)](#process-management-pm2)

**Search finds keywords. Sci-Trace finds foundations.**

Sci-Trace is an autonomous research assistant that lives in the cloud and is accessible at any moment through Discord or Slack. Beyond general scientific dialogue, given a particular scientific concept, it can trace that concept's intellectual ancestry, recursively navigating the citation graph to surface the foundational papers that a modern work is built on. What **would otherwise take hours of manual literature review takes minutes**.

The system pairs **OpenClaw**, an autonomous AI agent, with a persistent **Host server**, both running on an AWS EC2 instance. OpenClaw handles general research queries directly and, when it detects the intent to trace a concept's lineage, utilizes a specialized tool to trigger the research process. This tool sends a request to the Host server to spawn a **LangGraph agent** (the Python **Kernel**) that fetches papers via the Semantic Scholar API, uses LLM reasoning to evaluate methodological significance at each step, and recursively walks the citation graph until it identifies a foundational root. Results and real-time progress are automatically streamed back to the originating Discord or Slack channel.

**Key features:**
- Natural language interaction via Discord and Slack, with autonomous intent detection
- Recursive citation graph traversal using the Semantic Scholar API
- LLM-powered evaluation of methodological significance at each step (chain-of-thought, parallel batching)
- Outputs a citation DAG image and a narrative lineage summary per trace
- Slash command and natural language entry points; both converge on the same specialized LangGraph agent tool

Simplified request flow:

```
User (Discord / Slack)
        │
        ▼
   OpenClaw Agent  ──── intent analysis ────► direct response
        │
        │ lineage trace detected
        ▼
   Host Server  (Node.js, persistent)
        │
        │ spawns
        ▼
   Python Kernel  (transient)
        │
        ├── Semantic Scholar API  (paper fetch)
        ├── LLM eval  (methodological significance, per candidate)
        ├── LangGraph state machine  (recursive graph traversal)
        ├── Narrative synthesis
        └── DAG image rendering
        │
        ▼
   Host Server  ──► Discord / Slack
```

For a full technical deep-dive, see the [Sci-Trace DeepWiki](https://deepwiki.com/akharrou/sci-tracer/1-overview).

## Demos

> Traces in these demos were capped at 5 levels of depth and 5 parallel API queries at a time. Both are configurable.

<td style="width: 50%; padding: 10px;">
  <strong>Agentic Discovery</strong>
  <p style="font-size: 0.9em; color: #666;">
    Autonomous intent analysis and scholarly reasoning via natural language mentions.
  </p>
</td>

https://github.com/user-attachments/assets/d18b2fd4-0fd2-484b-847d-46e874d33f5f

<td style="width: 50%; padding: 10px;">
  <strong>Deterministic Mapping</strong>
  <p style="font-size: 0.9em; color: #666;">
    Instantaneous research generation via structured /trace commands.
  </p>
</td>

https://github.com/user-attachments/assets/f0a4b262-5831-42df-9953-69d4a557a8eb

<em>Sci-Trace automates the research tracing lifecycle: recursive graph traversal, LLM-powered methodological validation, and good-fidelity visual synthesis.</em>


## System Architecture: The Host-OpenClaw-Kernel Pattern

To ensure stability and responsiveness, Sci-Trace utilizes a decoupled, multi-layered architecture:

-   **The Body (Host):** A persistent Node.js daemon that manages UI abstraction for Discord and Slack, session state, and the orchestration of background research tasks.
-   **The Persona (OpenClaw):** A conversational agent acting as a **Senior Research Fellow** (formal, scholarly, and witty) that plans and reasons over user requests and triggers research tasks.
-   **The Brain (Kernel):** A transient Python process powered by **LangGraph** and **Pydantic AI**. It handles the heavy-duty logic of fetching data from the Semantic Scholar API and reasoning over citation significance.

<br>
<object><center style="float:none;position:relative;padding:1em;margin:0em 0em 0em 0em;width:90%"><img cite="" copyrighted="false" src="docs/assets/v22-arch-seq2.png" style="padding:1em;margin:.5em;border:1px solid grey;width:90%"><figcaption style="font-size: 0.9em; color: #666; margin-top: 0.5em;max-width:90%"><br><br>Three-layer architecture: The Host (Node.js body) routes slash commands directly, OpenClaw (Agent) autonomously interprets natural language and decides whether to trigger traces or respond directly, and the Kernel (Python brain) executes research tasks while querying external LLM and paper APIs.</figcaption></center></object>

## Full Request Lifecycle

The following sequence illustrates the autonomous handoff between the persistent chat interfaces and the ephemeral research kernel.

<br>
<object><center style="float:none;position:relative;padding:1em;margin:0em 0em 0em 0em;width:90%"><img cite="" copyrighted="false" src="docs/assets/v22-seq.png" style="padding:1em;margin:.5em;border:1px solid grey;width:90%"><figcaption style="font-size: 0.9em; color: #666; margin-top: 0.5em;max-width:90%"><br>Requests flow through two paths: slash commands route directly to the Host bridge, while natural language messages flow through OpenClaw for intent analysis. Both paths converge at the research kernel, which reports progress via tagged stdout and returns artifacts.</figcaption></center></object>

### Kernel Logic: LangGraph State Machine

The research kernel operates as a cyclic state machine, allowing it to recursively traverse the citation graph until it identifies a foundational root.

<br>
<object><center style="float:none;position:relative;padding:1em;margin:0em 0em 0em 0em;width:99%"><img cite="" copyrighted="false" src="docs/assets/v22-langgraph_agent.png" style="padding:1em;margin:.5em;border:1px solid grey;width:40%"><figcaption style="font-size: 0.9em; color: #666; margin-top: 0.5em;max-width:90%"><br>LangGraph state machine: Recursively searches for papers, filters references, evaluates candidates via Pydantic AI for methodological significance, and continues until a foundational root is identified. Finally synthesizes narrative results and generates visual citation graph.</figcaption></center></object>

<!--

## ⚡ Performance & Concurrency

### 1. Parallel Evaluation Engine
The **Python Kernel** utilizes `asyncio` to evaluate multiple paper candidates in parallel batches. Instead of checking ancestors one-by-one, the agent:
- **Batches:** Processes up to 5 candidates (configurable via `MAX_EVAL_BATCH_SIZE`) simultaneously.
- **Rate Limiting:** Implements an internal **Semaphore** to strictly respect LLM API limits (RPM) without sacrificing speed.

### 2. Global Resource Locking
To protect the EC2 instance's memory and CPU, Sci-Trace implements a system-wide file lock (`/tmp/sci-trace.lock`). This ensures only one heavy research kernel runs at a time, preventing race conditions between Discord, Slack, and OpenClaw requests.

### 3. Lossless Message Chunking
To ensure no research data is lost due to chat platform constraints, the **Host UI Layer** automatically splits long narrative summaries into sequential, ordered messages (Discord: 4096, Slack: 3000 characters).

-->

---

## Setup & Installation

### 1. Prerequisites
- Node.js 20+ / Python 3.11+
- `uv` (Python package manager)
- AWS Account (for infrastructure)

### 2. Environment Configuration
Create a `.env` file in the root directory:
```ini
# --- Host (Discord & Slack) ---
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...

# --- Kernel (LLM & Data) ---
OPENROUTER_API_KEY=...
SEMANTIC_SCHOLAR_API_KEY=...
```

### 3. Installation
```bash
make install
```

### 4. Running the Trace
Once the bot is running (`npm start`), use the slash command:
` /trace topic: "Attention Is All You Need" `
Or mention the bot:
` @Research Assistant where did BERT come from? `

---

## Cloud Infrastructure & Deployment

Sci-Trace is designed with high availability in mind and is designed to operate autonomously in the cloud. It includes a complete **Infrastructure as Code (IaC)** suite for automated provisioning on AWS.

### Provisioning (Terraform)

Terraform configurations are located in `infra/`. They provision:

- **Provider:** AWS
- **Instance:** `t3.medium` running Ubuntu 22.04 LTS
- **Bootstrap:** `user_data.sh` installs Node.js 20, Python 3.11, `uv`, and PM2 on first boot

### Deployment

```bash
./deploy.sh <EC2_PUBLIC_IP> <PEM_KEY_PATH>
```

Uses `rsync` to synchronize the codebase (excluding local environments) and performs remote setup for both the Kernel and the Host.

### Process Management (PM2)

The Host daemon is managed by PM2, configured via `ecosystem.config.js`. Logs are written to `host/logs/app.log`. The process restarts automatically on crash or server reboot.

<!--

### 3. OpenClaw Setup (Conversational Agent Configuration)

OpenClaw is the autonomous reasoning layer that interprets natural language requests and triggers research traces. After deployment, SSH into the instance and configure it, register the research skill, configure communication platforms, and restart the gateway to apply changes.

**Step 1: Initialize OpenClaw**
```bash
ssh -i <PEM_KEY_PATH> ubuntu@<EC2_PUBLIC_IP>
openclaw onboard
```
This sets up the base agent personality and connects it to your configured LLM (OpenRouter or Gemini).

**Step 2: Register Research Skills**
Tell OpenClaw where to find the custom `/trace` skill:
```bash
openclaw config set skills.load.extraDirs '["/home/ubuntu/sci-trace/host/skills"]' --json
```

**Step 3: Restart the Gateway**
Apply the configuration changes:
```bash
openclaw gateway restart
```

-->
