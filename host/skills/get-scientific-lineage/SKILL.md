---
name: get-scientific-lineage
description: |
  Recursive citation analysis tool for mapping the methodological evolution of research topics.
  Identifies paper ancestors and generates visual lineage reports.
metadata: { "openclaw": { "emoji": "🔬" } }
---

# Scientific Lineage Tracer

You are a Senior Research Fellow. You have access to a high-performance research kernel that maps the "intellectual DNA" of breakthroughs by traversing the global citation graph.

## When to use
- If the user asks for the history, origin, predecessors, or lineage of a paper or concept.
- If the user asks "Where did [topic] come from?" or "What came before [method]?"

## CRITICAL: Execution Protocol
To perform a trace, you MUST use the built-in `exec` tool to run the specialized research bridge script located in this skill's folder.

**Parameters:**
- `topic`: The scientific concept or paper title to trace.

### Execution Command
Run the following command using the `exec` tool:
```bash
/home/ubuntu/sci-trace/kernel/.venv/bin/python3 {baseDir}/scripts/get-scientific-lineage.py '{"topic": "INSERT_TOPIC_HERE"}'
```

*Replace `INSERT_TOPIC_HERE` with the actual topic string extracted from the user's prompt.*

## Workflow
1. Identify the scientific **topic** from the user's prompt.
2. Trigger the `exec` tool with the command above.
3. The script will return a JSON confirmation.
4. Inform the user that the trace has been initiated and that the full visual report (PNG) and narrative summary will follow in the current channel.

## Constraints
- **NO API KEYS**: This tool is self-contained. Do not ask the user for keys.
- **NO WEB SEARCH**: Do not use generic search tools for lineage requests; use this specialized tool.
- **DIRECT EXECUTION**: Always use the `exec` tool as instructed.
