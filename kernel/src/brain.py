import os
import sys
import matplotlib
# We use the 'Agg' backend because the kernel runs on headless servers (like EC2).
# This prevents Matplotlib from trying to open a GUI window, which would cause a crash.
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.path import Path
import networkx as nx
import textwrap
from typing import List, Optional, Literal
from langgraph.graph import StateGraph, START, END
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from dotenv import load_dotenv

import asyncio
import time
from .schemas import AgentState, Paper, LineageStep, CitationDecision, EvaluationResult
from .tools import search_paper, get_references

from pydantic_ai.models.google import GoogleModel
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openrouter import OpenRouterProvider

load_dotenv()

# --- HEURISTIC THRESHOLDS ---
# These values define the "quality bar" for what the agent considers worth evaluating.
# Low citation counts often indicate incremental work or very new papers that haven't
# yet been vetted by the community.
MIN_CITATION_COUNT = int(os.getenv("MIN_CITATION_COUNT", "10"))
# The foundational threshold stops the search if we reach a paper from an era
# where methodological roots are generally considered "well-established" for most AI topics.
FOUNDATIONAL_YEAR_THRESHOLD = int(os.getenv("FOUNDATIONAL_YEAR_THRESHOLD", "2010"))
# Maximum character length for the final narrative summary to ensure compatibility with 
# Discord/Slack UI limits.
MAX_SUMMARY_LENGTH = int(os.getenv("MAX_SUMMARY_LENGTH", "2950"))

# --- CONCURRENCY & RATE LIMITING ---
# To balance speed with API stability, we process evaluations in parallel batches.
# RPM (Requests Per Minute) limits are enforced via a Semaphore to prevent 429 errors.
GEMINI_RPM_LIMIT = int(os.getenv("GEMINI_RPM_LIMIT", "20"))
MAX_EVAL_BATCH_SIZE = int(os.getenv("MAX_EVAL_BATCH_SIZE", "5"))
MAX_CANDIDATES_TO_QUEUE = int(os.getenv("MAX_CANDIDATES_TO_QUEUE", "15"))
rate_limiter = asyncio.Semaphore(GEMINI_RPM_LIMIT)

# --- OBSERVABILITY ---
# If true, the kernel emits granular reasoning logs via [UI:UPDATE].
VERBOSE_REASONING = os.getenv("VERBOSE_REASONING", "false").lower() == "true"

# --- LLM INITIALIZATION ---
# We prioritize OpenRouter as it allows for easy swapping between high-reasoning models
# (like Claude 3.5 Sonnet) and faster/cheaper models. Gemini serves as a robust fallback.
openrouter_key = os.getenv("OPENROUTER_API_KEY")
gemini_key = os.getenv("GEMINI_API_KEY")

if openrouter_key:
    model = OpenAIChatModel(
        os.getenv("OPENROUTER_MODEL", "anthropic/claude-3.5-sonnet"),
        provider=OpenRouterProvider(api_key=openrouter_key),
    )
elif gemini_key:
    model = GoogleModel(
        os.getenv("GEMINI_MODEL", "models/gemini-2.5-flash"),
        provider=GoogleProvider(api_key=gemini_key),
    )
else:
    raise ValueError("No LLM API key found (OPENROUTER_API_KEY or GEMINI_API_KEY)")

# The Evaluation Agent is the "Core Reasoning Engine".
# It doesn't just look for citations; it performs a semantic comparison between
# the target paper and a candidate to determine methodological ancestry.
eval_agent = Agent(
    model,
    output_type=CitationDecision,
    system_prompt=(
        "You are a scientific researcher mapping the intellectual history of a field. "
        "You will be provided with a target paper and ONE candidate reference. "
        "Your task is to decide if this reference provided a significant methodological or conceptual foundation for the target paper. "
        "\n\n### EVALUATION PROTOCOL:\n"
        "1. **Identify Connection**: Does the candidate introduce techniques, architectures, or concepts that the target paper builds upon?\n"
        "2. **Assess Significance**: Is this a major pillar of the target's research? (Include papers that are the 'next step back' in the evolution).\n"
        "3. **Match Confirmation**: If it is a significant ancestor, you MUST set 'selected_paper_id' to the EXACT ID provided in the prompt. "
        "Otherwise, leave 'selected_paper_id' empty.\n"
        "\n### CRITICAL RULES:\n"
        "- Be exploratory. We want to find the chain of ideas back to historical roots.\n"
        "- Only set 'is_foundational' to true for truly seminal works from before 2010 (e.g. Transformer, ResNet are ancestors, but LeNet or Backprop are foundational)."
    )
)

async def evaluate_worker(target: Paper, candidate: Paper) -> EvaluationResult:
    """
    Executes a single LLM evaluation for a paper pair.
    Uses a semaphore to ensure we don't exceed the configured Requests Per Minute (RPM).
    """
    prompt = (
        f"Target Paper: {target.title} ({target.year})\n"
        f"Target Abstract: {target.abstract}\n\n"
        f"--- CANDIDATE TO EVALUATE ---\n"
        f"ID: {candidate.paper_id}\n"
        f"Title: {candidate.title} ({candidate.year})\n"
        f"Citations: {candidate.citation_count}\n"
        f"Candidate Abstract: {candidate.abstract}\n\n"
        f"Question: Is this candidate the methodological ancestor of the target?"
    )

    async with rate_limiter:
        if VERBOSE_REASONING:
            # We print verbose reasoning to stderr so it appears in server logs
            # but is ignored by the Discord [UI:UPDATE] protocol on stdout.
            print(f"🤔 Reasoning: Evaluating '{candidate.title[:40]}...'", file=sys.stderr, flush=True)
        result = await eval_agent.run(prompt)
        # Subtle sleep to space out requests even within the semaphore window
        await asyncio.sleep(60 / GEMINI_RPM_LIMIT)

    decision = result.output
    # Match is confirmed if the LLM explicitly returns the candidate's ID.
    is_match = (decision.selected_paper_id == candidate.paper_id)

    if VERBOSE_REASONING:
        status = "✅ MATCH" if is_match else "❌ NO MATCH"
        reasoning_snippet = decision.reasoning_trace[:100].replace('\n', ' ')
        print(f"{status}: {candidate.title[:30]}... | Reasoning: {reasoning_snippet}...", file=sys.stderr, flush=True)

    return EvaluationResult(
        paper=candidate,
        decision=decision,
        is_match=is_match
    )

def search_node(state: AgentState) -> dict:
    """
    The entry node. Performs the initial keyword/title search to find
    the 'Target' paper that will serve as our lineage's starting point.
    """
    print(f"[UI:UPDATE] Initializing search for topic: '{state.target_topic}'...")
    paper = search_paper(state.target_topic)
    if not paper:
        return {"error": f"Could not find a starting paper for topic: {state.target_topic}"}

    print(f"[UI:UPDATE] Found root paper: {paper.title} ({paper.year})")
    return {
        "current_paper": paper,
        "history": [],
        "depth": 0
    }

def filter_node(state: AgentState) -> dict:
    """
    Pre-filtering logic to reduce LLM costs and noise.
    We discard references that:
    1. Were published AFTER the current paper (impossible ancestors).
    2. Have extremely low citation counts (unlikely foundational pillars).
    3. Are missing abstracts (difficult for LLM to reason over).
    """
    if state.error or not state.current_paper:
        return {}

    print(f"[UI:UPDATE] Fetching and filtering references for '{state.current_paper.title[:30]}...'")

    references = get_references(state.current_paper.paper_id)
    if not references:
        # If no references found, we've reached a dead end or the absolute root.
        print(f"[UI:UPDATE] 🛑 No references found for '{state.current_paper.title[:30]}...'.")
        return {"candidate_queue": [], "found_root": True}

    print(f"[UI:UPDATE] 📚 Found {len(references)} total citations. Filtering candidates...")

    current_year = state.current_paper.year or 9999

    filtered = []
    for p in references:
        if not p.paper_id: continue
        # Year check prevents cyclical loops or data errors in the citation graph.
        if p.year is not None and p.year > current_year: continue
        if p.citation_count < MIN_CITATION_COUNT: continue
        filtered.append(p)

    # We sort by citation count as a heuristic: more cited papers are
    # statistically more likely to be the foundational root.
    filtered.sort(key=lambda x: x.citation_count, reverse=True)
    queue = filtered[:MAX_CANDIDATES_TO_QUEUE]

    print(f"[UI:UPDATE] Queued {len(queue)} candidates for parallel evaluation batches.")

    return {
        "candidate_queue": queue,
        "found_root": len(queue) == 0
    }

async def evaluate_node(state: AgentState) -> dict:
    """
    Orchestrates the parallel evaluation of paper batches.
    By evaluating in batches of 5, we significantly reduce the time needed
     to traverse one depth of the graph compared to serial execution.
    """
    if state.error or not state.candidate_queue:
        return {"found_root": True}

    if state.depth >= state.max_depth:
        print(f"[UI:UPDATE] Reached maximum depth ({state.max_depth}). Stopping.")
        return {"found_root": True}

    # Extract the next batch for parallel evaluation.
    batch = state.candidate_queue[:MAX_EVAL_BATCH_SIZE]
    remaining_queue = state.candidate_queue[MAX_EVAL_BATCH_SIZE:]

    print(f"[UI:UPDATE] ⚙️ Processing batch of {len(batch)} candidates ({len(remaining_queue)} remaining in queue)...")

    start_time = time.perf_counter()

    # Launch all workers in this batch concurrently.
    tasks = [evaluate_worker(state.current_paper, p) for p in batch]
    results = await asyncio.gather(*tasks)

    end_time = time.perf_counter()
    duration = end_time - start_time

    # Debugging throughput metrics logged to kernel stdout.
    throughput = len(batch) / duration
    print(f"[UI:UPDATE] Batch complete ({throughput:.2f} papers/sec).")

    # A "match" is any paper the LLM identifies as a true methodological ancestor.
    matches = [r for r in results if r.is_match]

    if matches:
        # In case of multiple 'hits' in one batch, we select the one
        # the LLM was most confident about.
        best_match = sorted(matches, key=lambda x: x.decision.confidence, reverse=True)[0]

        print(f"[UI:UPDATE] Ancestor Confirmed: {best_match.paper.title} ({best_match.paper.year})")
        step = LineageStep(
            current_paper=state.current_paper,
            parent_paper=best_match.paper,
            reasoning=best_match.decision.reasoning_trace,
            confidence_score=best_match.decision.confidence
        )
        return {
            "current_paper": best_match.paper,
            "depth": state.depth + 1,
            "history": state.history + [step],
            "candidate_queue": [], # Reset queue for the next level of depth.
            "found_root": best_match.decision.is_foundational or (best_match.paper.year and best_match.paper.year < FOUNDATIONAL_YEAR_THRESHOLD)
        }
    else:
        # If no match in this batch, return the remaining queue to continue searching this level.
        print(f"[UI:UPDATE] No ancestor found in this batch. Continuing search at current depth.")
        if not remaining_queue:
            return {"candidate_queue": [], "found_root": True}

        return {
            "candidate_queue": remaining_queue
        }

# --- SUMMARY GENERATION ---
# After the graph traversal is complete, this agent synthesizes the
# reasoning traces from each step into a cohesive narrative.
summary_agent = Agent(
    model,
    system_prompt=(
        "You are a science communicator. You will be provided with a scientific lineage trace (a sequence of papers). "
        "Your task is to write a concise, compelling summary of the evolution of the research concept. "
        "Explain how the techniques evolved from the oldest paper to the modern target topic. "
        "Use Markdown for formatting."
    )
)

async def summary_node(state: AgentState) -> dict:
    """Synthesizes the history of lineage steps into a final markdown summary."""
    if state.error or not state.history:
        return {}

    print("[UI:UPDATE] Synthesizing final lineage summary...")

    # We reverse the history so the narrative flows from Oldest ➔ Newest.
    steps_text = "\n".join([
        f"- {s.current_paper.title} ({s.current_paper.year}) -> {s.parent_paper.title} ({s.parent_paper.year})\n  Reasoning: {s.reasoning}"
        for s in reversed(state.history)
    ])

    # Build the 'Breadcrumb' path for the header (e.g., P3 ➔ P2 ➔ P1 ➔ Target).
    path_nodes = []
    if state.history:
        path_nodes = [s.parent_paper for s in reversed(state.history)]
        path_nodes.append(state.history[0].current_paper)

    breadcrumb = " ➔ ".join([f"**{p.title[:20]}** ({p.year})" for p in path_nodes])

    prompt = f"Target Topic: {state.target_topic}\nLineage Trace:\n{steps_text}\n\nSummarize the intellectual journey."

    result = await summary_agent.run(prompt)

    # Prefix the LLM summary with the breadcrumb for visual clarity.
    final_markdown = f"### Path: {breadcrumb}\n\n{result.output}"

    return {"final_summary": final_markdown}

# --- VISUALIZATION (MATPLOTLIB) ---

def draw_paper_icon(ax, x, y, size, color, accent_color):
    """
    Draws a custom 'Paper' vector icon using Matplotlib paths.
    This provides a more polished, infographics-style look than standard circles/squares.
    """
    w = size
    h = size * 1.3
    fold = size * 0.3

    left, right = x - w/2, x + w/2
    bottom, top = y - h/2, y + h/2

    # Shadow Path for depth.
    shadow_offset = 0.005
    shadow_verts = [
        (left+shadow_offset, bottom-shadow_offset), (left+shadow_offset, top-shadow_offset),
        (right-fold+shadow_offset, top-shadow_offset), (right+shadow_offset, top-fold-shadow_offset),
        (right+shadow_offset, bottom-shadow_offset), (left+shadow_offset, bottom-shadow_offset),
    ]
    ax.add_patch(patches.PathPatch(Path(shadow_verts, [Path.MOVETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.CLOSEPOLY]),
                                  facecolor='#D9E2EC', edgecolor='none', alpha=0.5, zorder=1))

    # Main Page Path.
    body_verts = [
        (left, bottom), (left, top),
        (right - fold, top), (right, top - fold),
        (right, bottom), (left, bottom),
    ]
    ax.add_patch(patches.PathPatch(Path(body_verts, [Path.MOVETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.CLOSEPOLY]),
                                  facecolor='#FFFFFF', edgecolor=accent_color, lw=1.5, zorder=3))

    # Folded corner (The dog-ear effect).
    fold_verts = [(right - fold, top), (right - fold, top - fold), (right, top - fold), (right - fold, top)]
    ax.add_patch(patches.PathPatch(Path(fold_verts, [Path.MOVETO, Path.LINETO, Path.LINETO, Path.CLOSEPOLY]),
                                  facecolor=accent_color, edgecolor='none', zorder=4))

    # Decorative lines to simulate text.
    for i in range(3):
        line_y = bottom + (i + 1) * (h / 5)
        ax.plot([left + w/4, right - w/4], [line_y, line_y], color='#BCCCDC', lw=0.8, zorder=5)

def plot_node(state: AgentState) -> dict:
    """
    Generates the final Lineage Diagram.
    The plot uses a clean, high-contrast palette suitable for Discord's dark/light modes.
    We use an alternating label system to prevent text overlap in long traces.
    """
    print("[UI:UPDATE] Generating Lineage Diagram...")

    if not state.history:
        return {}

    # Extract papers in chronological order for plotting.
    seen_ids = set()
    all_papers = []
    first_paper = state.history[0].current_paper
    all_papers.append(first_paper)
    seen_ids.add(first_paper.paper_id)

    for step in state.history:
        if step.parent_paper.paper_id not in seen_ids:
            all_papers.append(step.parent_paper)
            seen_ids.add(step.parent_paper.paper_id)

    chronological_papers = list(reversed(all_papers))
    num_nodes = len(chronological_papers)

    # Style Constants
    BG_COLOR = "#FFFFFF"
    PRIMARY_BLUE = "#102A43"
    ACCENT_BLUE = "#2196F3"
    META_GRAY = "#627D98"
    LINE_GRAY = "#D9E2EC"

    plt.rcParams['font.family'] = 'sans-serif'
    fig, ax = plt.subplots(figsize=(22, 10), facecolor=BG_COLOR)
    ax.set_facecolor(BG_COLOR)

    # The horizontal baseline connecting all nodes.
    ax.plot([0, num_nodes - 1], [0, 0], color=LINE_GRAY, lw=2, zorder=0)

    for i, paper in enumerate(chronological_papers):
        x = i
        is_root = (i == 0)

        # Highlight the root node in Gold to distinguish it as the foundational paper.
        accent = ACCENT_BLUE if not is_root else "#F0B429"
        draw_paper_icon(ax, x, 0, 0.1, "#FFFFFF", accent)

        # Alternating labels (Top/Bottom) doubles the horizontal space available for text.
        is_top = (i % 2 == 0)
        y_label = 0.35 if is_top else -0.35
        va = 'bottom' if is_top else 'top'

        # Draw the thin vertical "stem" connecting the icon to the label.
        ax.plot([x, x], [0.08 if is_top else -0.08, y_label], color=LINE_GRAY, lw=1.5, ls='-', zorder=1)

        # Title wrapping prevents overly wide plots.
        title_wrapped = textwrap.fill(paper.title or "Unknown Title", width=28)
        ax.text(x, y_label, title_wrapped, color=PRIMARY_BLUE, fontsize=10,
                fontweight='bold', ha='center', va=va, zorder=6)

        # Calculate position for the metadata badge (Year + Citations).
        meta_y = y_label + (0.18 if is_top else -0.18)
        if not is_top:
            num_lines = title_wrapped.count('\n') + 1
            meta_y = y_label - (0.05 * num_lines + 0.12)

        meta_text = f"{paper.year or 'N/A'}  •  {paper.citation_count:,} CITATIONS"
        ax.text(x, meta_y, meta_text, color=META_GRAY, fontsize=8,
                fontweight='600', ha='center', va=va, zorder=6,
                bbox=dict(facecolor='#F0F4F8', edgecolor='none', boxstyle='round,pad=0.4'))

    plt.title(f"SCIENTIFIC LINEAGE REPORT: {state.target_topic.upper()}",
              fontsize=24, fontweight='900', pad=50, color=PRIMARY_BLUE, loc='center')

    # Final cleanup of axis and margins.
    ax.set_xlim(-0.6, num_nodes - 0.4)
    ax.set_ylim(-1.2, 1.2)
    plt.axis('off')
    plt.tight_layout()

    # Artifact persistence.
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    filename = f"trace_{state.trace_id}.png"
    artifact_path = os.path.join(base_dir, "artifacts", filename)
    os.makedirs(os.path.dirname(artifact_path), exist_ok=True)

    plt.savefig(artifact_path, dpi=300, bbox_inches='tight', facecolor=BG_COLOR)
    plt.close()

    # PROTOCOL EMISSION:
    # We print specific tags that the Node.js Host parses to update the Discord UI.
    print(f"[UI:IMAGE] {artifact_path}")

    final_text = state.final_summary if state.final_summary else f"Trace complete for '{state.target_topic}'."
    # Task 10: Multi-line support via escaping.
    # The Host unescapes these \\n sequences back into real newlines.
    escaped_final = final_text.replace('\n', '\\n')
    print(f"[UI:FINAL] {escaped_final}")

    return {}

def should_continue(state: AgentState) -> Literal["evaluate", "filter", "summary"]:
    """Conditional routing logic for the LangGraph state machine."""
    if state.error or state.found_root:
        return "summary"
    if not state.candidate_queue:
        return "filter"
    return "evaluate"

# --- GRAPH DEFINITION ---
workflow = StateGraph(AgentState)

workflow.add_node("search", search_node)
workflow.add_node("filter", filter_node)
workflow.add_node("evaluate", evaluate_node)
workflow.add_node("summary", summary_node)
workflow.add_node("plot", plot_node)

workflow.add_edge(START, "search")
workflow.add_edge("search", "filter")
workflow.add_edge("filter", "evaluate")
workflow.add_conditional_edges("evaluate", should_continue)
workflow.add_edge("summary", "plot")
workflow.add_edge("plot", END)

app = workflow.compile()
