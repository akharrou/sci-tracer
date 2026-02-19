import os
import matplotlib
matplotlib.use('Agg') # Force non-interactive backend for server-side plotting
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

load_dotenv()

# Heuristic Thresholds (Load from env or use defaults)
MIN_CITATION_COUNT = int(os.getenv("MIN_CITATION_COUNT", "10"))
FOUNDATIONAL_YEAR_THRESHOLD = int(os.getenv("FOUNDATIONAL_YEAR_THRESHOLD", "2010"))

# Rate Limiting Configuration (Task 8)
GEMINI_RPM_LIMIT = int(os.getenv("GEMINI_RPM_LIMIT", "20"))
MAX_EVAL_BATCH_SIZE = int(os.getenv("MAX_EVAL_BATCH_SIZE", "5"))
# Semaphore ensures we don't exceed the configured RPM in parallel batches
rate_limiter = asyncio.Semaphore(GEMINI_RPM_LIMIT)

# Initialize Pydantic AI Agent for reasoning using Google Gemini
model = GoogleModel(
    "models/gemini-2.5-flash",
    provider=GoogleProvider(api_key=os.getenv("GEMINI_API_KEY")),
)

# Sequential Evaluation Agent (Evaluates ONE candidate at a time)
eval_agent = Agent(
    model,
    output_type=CitationDecision,
    system_prompt=(
        "You are a rigorous scientific reviewer. You will be provided with a target paper and ONE candidate reference. "
        "Your task is to decide if this reference is a primary intellectual or methodological ancestor of the target. "
        "\n\n### EVALUATION PROTOCOL:\n"
        "1. **Identify Method**: Does the candidate provide the methodological foundation for the target?\n"
        "2. **Validate Citation**: Is this a casual mention or a foundational root?\n"
        "3. **Match Confirmation**: If it is a match, you MUST set 'selected_paper_id' to the EXACT ID provided in the prompt. "
        "Otherwise, leave 'selected_paper_id' empty.\n"
        "\n### CRITICAL RULE:\n"
        "Be inclusive of papers that represent the 'next step back' in the lineage. "
        "Only mark 'is_foundational' for seminal pre-2010 works."
    )
)

# --- Evaluation Worker Function ---
async def evaluate_worker(target: Paper, candidate: Paper) -> EvaluationResult:
    """Async worker to evaluate a single (target, candidate) pair with rate limiting."""
    prompt = (
        f"Target Paper: {target.title} ({target.year})\n"
        f"Abstract: {target.abstract}\n\n"
        f"--- CANDIDATE TO EVALUATE ---\n"
        f"ID: {candidate.paper_id}\n"
        f"Title: {candidate.title} ({candidate.year})\n"
        f"Citations: {candidate.citation_count}\n\n"
        f"Question: Is this candidate the methodological ancestor of the target?"
    )
    
    # Task 8: Acquire semaphore before making the API call
    async with rate_limiter:
        result = await eval_agent.run(prompt)
        await asyncio.sleep(60 / GEMINI_RPM_LIMIT)
        
    decision = result.output
    # Match confirmed if ID matches OR if the reasoning is highly confident
    is_match = (decision.selected_paper_id == candidate.paper_id)
    
    return EvaluationResult(
        paper=candidate,
        decision=decision,
        is_match=is_match
    )

def search_node(state: AgentState) -> dict:
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
    if state.error or not state.current_paper:
        return {}
    
    print(f"[UI:UPDATE] Fetching and filtering references for '{state.current_paper.title[:30]}...'")
    
    references = get_references(state.current_paper.paper_id)
    if not references:
        return {"candidate_queue": [], "found_root": True}
    
    current_year = state.current_paper.year or 9999
    
    filtered = []
    for p in references:
        if not p.paper_id: continue
        if p.year is not None and p.year > current_year: continue
        if p.citation_count < MIN_CITATION_COUNT: continue
        filtered.append(p)
    
    # Sort and take top 15 (Queue for Parallel Evaluation batches)
    filtered.sort(key=lambda x: x.citation_count, reverse=True)
    queue = filtered[:15]
    
    print(f"[UI:UPDATE] Queued {len(queue)} candidates for parallel evaluation batches.")
    
    return {
        "candidate_queue": queue,
        "found_root": len(queue) == 0
    }

async def evaluate_node(state: AgentState) -> dict:
    """Processes up to a batch of papers in parallel from the queue."""
    if state.error or not state.candidate_queue:
        return {"found_root": True}
    
    if state.depth >= state.max_depth:
        print(f"[UI:UPDATE] Reached maximum depth ({state.max_depth}). Stopping.")
        return {"found_root": True}

    # Take the next batch (up to MAX_EVAL_BATCH_SIZE)
    batch = state.candidate_queue[:MAX_EVAL_BATCH_SIZE]
    remaining_queue = state.candidate_queue[MAX_EVAL_BATCH_SIZE:]
    
    print(f"[UI:UPDATE] Starting parallel batch evaluation of {len(batch)} papers (Limit: {MAX_EVAL_BATCH_SIZE})...")
    
    start_time = time.perf_counter()
    
    # --- CONCURRENT EXECUTION ---
    tasks = [evaluate_worker(state.current_paper, p) for p in batch]
    results = await asyncio.gather(*tasks)
    
    end_time = time.perf_counter()
    duration = end_time - start_time
    throughput = len(batch) / duration
    
    print(f"[UI:UPDATE] Batch complete. Throughput: {throughput:.2f} papers/sec (Processed {len(batch)} in {duration:.2f}s)")
    
    # Process results: Look for matches
    matches = [r for r in results if r.is_match]
    
    if matches:
        # If multiple matches, pick the one with highest confidence
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
            "candidate_queue": [], # Found ancestor at this level, clear queue
            "found_root": best_match.decision.is_foundational or (best_match.paper.year and best_match.paper.year < FOUNDATIONAL_YEAR_THRESHOLD)
        }
    else:
        # No match in this batch
        print(f"[UI:UPDATE] No ancestor found in this batch of {len(batch)}.")
        if not remaining_queue:
            print("[UI:UPDATE] All queued candidates evaluated. No ancestor found.")
            return {"candidate_queue": [], "found_root": True}
        
        return {
            "candidate_queue": remaining_queue
        }

summary_agent = Agent(
    model,
    system_prompt=(
        "You are a science communicator. You will be provided with a scientific lineage trace (a sequence of papers). "
        "Your task is to write a concise, compelling summary of the evolution of the research concept. "
        "Explain how the techniques evolved from the oldest paper to the modern target topic. "
        "Use Markdown for formatting."
    )
)

def summary_node(state: AgentState) -> dict:
    if state.error or not state.history:
        return {}
    
    print("[UI:UPDATE] Synthesizing final lineage summary...")
    
    # Format the history for the LLM
    steps_text = "\n".join([
        f"- {s.current_paper.title} ({s.current_paper.year}) -> {s.parent_paper.title} ({s.parent_paper.year})\n  Reasoning: {s.reasoning}"
        for s in reversed(state.history) # Oldest to Newest is better for narrative
    ])
    
    # Create breadcrumb path (Oldest ➔ ... ➔ Newest)
    path_nodes = []
    # Ancestors are in parent_paper, the last step's parent is the oldest
    if state.history:
        # History is [Target->P1, P1->P2, P2->P3]
        # Path should be P3 ➔ P2 ➔ P1 ➔ Target
        path_nodes = [s.parent_paper for s in reversed(state.history)]
        path_nodes.append(state.history[0].current_paper)
    
    breadcrumb = " ➔ ".join([f"**{p.title[:20]}** ({p.year})" for p in path_nodes])
    
    prompt = f"Target Topic: {state.target_topic}\nLineage Trace:\n{steps_text}\n\nSummarize the intellectual journey."
    
    result = summary_agent.run_sync(prompt)
    
    final_markdown = f"### Path: {breadcrumb}\n\n{result.output}"
    
    return {"final_summary": final_markdown}

def draw_paper_icon(ax, x, y, size, color, accent_color):
    """Draws a refined, professional 'Paper' icon with a subtle shadow."""
    w = size
    h = size * 1.3
    fold = size * 0.3
    
    # Coordinates relative to center (x,y)
    left, right = x - w/2, x + w/2
    bottom, top = y - h/2, y + h/2
    
    # 1. Subtle Shadow (Soft Gray)
    shadow_offset = 0.005
    shadow_verts = [
        (left+shadow_offset, bottom-shadow_offset), (left+shadow_offset, top-shadow_offset),
        (right-fold+shadow_offset, top-shadow_offset), (right+shadow_offset, top-fold-shadow_offset),
        (right+shadow_offset, bottom-shadow_offset), (left+shadow_offset, bottom-shadow_offset),
    ]
    ax.add_patch(patches.PathPatch(Path(shadow_verts, [Path.MOVETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.CLOSEPOLY]), 
                                  facecolor='#D9E2EC', edgecolor='none', alpha=0.5, zorder=1))
    
    # 2. Main Body (White/Clean)
    body_verts = [
        (left, bottom), (left, top),
        (right - fold, top), (right, top - fold),
        (right, bottom), (left, bottom),
    ]
    ax.add_patch(patches.PathPatch(Path(body_verts, [Path.MOVETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.CLOSEPOLY]), 
                                  facecolor='#FFFFFF', edgecolor=accent_color, lw=1.5, zorder=3))
    
    # 3. The Fold (Triangle - Accent color or shaded)
    fold_verts = [(right - fold, top), (right - fold, top - fold), (right, top - fold), (right - fold, top)]
    ax.add_patch(patches.PathPatch(Path(fold_verts, [Path.MOVETO, Path.LINETO, Path.LINETO, Path.CLOSEPOLY]), 
                                  facecolor=accent_color, edgecolor='none', zorder=4))
    
    # 4. Content lines (simulated text)
    for i in range(3):
        line_y = bottom + (i + 1) * (h / 5)
        ax.plot([left + w/4, right - w/4], [line_y, line_y], color='#BCCCDC', lw=0.8, zorder=5)

def plot_node(state: AgentState) -> dict:
    print("[UI:UPDATE] Generating Prestigeous Conference Infographic...")
    
    if not state.history:
        print("[UI:UPDATE] No lineage history to plot.")
        return {}

    # 1. Data Processing
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
    
    # 2. Conference Palette (Prestige & Clarity)
    BG_COLOR = "#FFFFFF"       # Pristine White
    PRIMARY_BLUE = "#102A43"   # Deep Professional Blue
    ACCENT_BLUE = "#2196F3"    # Vibrant Innovation Blue
    TEXT_GRAY = "#334E68"      # Slate for main text
    META_GRAY = "#627D98"      # Muted slate for metadata
    LINE_GRAY = "#D9E2EC"      # Light track
    
    plt.rcParams['font.family'] = 'sans-serif'
    fig, ax = plt.subplots(figsize=(22, 10), facecolor=BG_COLOR)
    ax.set_facecolor(BG_COLOR)
    
    # 3. The Central Lineage Path
    ax.plot([0, num_nodes - 1], [0, 0], color=LINE_GRAY, lw=2, zorder=0)
    ax.scatter(range(num_nodes), [0]*num_nodes, color=PRIMARY_BLUE, s=50, zorder=2)
    
    # 4. Draw Nodes (Milestones)
    for i, paper in enumerate(chronological_papers):
        x = i
        is_target = (i == num_nodes - 1)
        is_root = (i == 0)
        
        # Draw Icon
        accent = ACCENT_BLUE if not is_root else "#F0B429" # Gold for Root
        draw_paper_icon(ax, x, 0, 0.1, "#FFFFFF", accent)
        
        # Label Positioning (Alternating)
        is_top = (i % 2 == 0)
        y_label = 0.35 if is_top else -0.35
        va = 'bottom' if is_top else 'top'
        
        # Vertical Connector
        ax.plot([x, x], [0.08 if is_top else -0.08, y_label], color=LINE_GRAY, lw=1.5, ls='-', zorder=1)
        
        # Title
        title_wrapped = textwrap.fill(paper.title or "Unknown Title", width=28)
        ax.text(x, y_label, title_wrapped, color=PRIMARY_BLUE, fontsize=10, 
                fontweight='bold', ha='center', va=va, zorder=6)
        
        # Metadata Badge
        meta_y = y_label + (0.18 if is_top else -0.18)
        if not is_top:
            num_lines = title_wrapped.count('\n') + 1
            meta_y = y_label - (0.05 * num_lines + 0.12)

        meta_text = f"{paper.year or 'N/A'}  •  {paper.citation_count:,} CITATIONS"
        ax.text(x, meta_y, meta_text, color=META_GRAY, fontsize=8, 
                fontweight='600', ha='center', va=va, zorder=6,
                bbox=dict(facecolor='#F0F4F8', edgecolor='none', boxstyle='round,pad=0.4'))

    # 5. Header & Branding
    plt.title(f"SCIENTIFIC LINEAGE REPORT: {state.target_topic.upper()}", 
              fontsize=24, fontweight='900', pad=50, color=PRIMARY_BLUE, loc='center')
    
    ax.text(0.5, 1.05, "METHODOLOGICAL EVOLUTION AND INTELLECTUAL ANCESTRY", 
            ha='center', transform=ax.transAxes, fontsize=12, color=ACCENT_BLUE, fontweight='bold')

    # 6. Cleanup
    ax.set_xlim(-0.6, num_nodes - 0.4)
    ax.set_ylim(-1.2, 1.2)
    plt.axis('off')
    plt.tight_layout()

    # Save
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    filename = f"trace_{state.trace_id}.png"
    artifact_path = os.path.join(base_dir, "artifacts", filename)
    os.makedirs(os.path.dirname(artifact_path), exist_ok=True)
    
    plt.savefig(artifact_path, dpi=300, bbox_inches='tight', facecolor=BG_COLOR)
    plt.close()
    
    print(f"[UI:IMAGE] {artifact_path}")
    final_text = state.final_summary if state.final_summary else f"Trace complete for '{state.target_topic}'."
    print(f"[UI:FINAL] {final_text}")
    return {}

def should_continue(state: AgentState) -> Literal["evaluate", "filter", "summary"]:
    if state.error or state.found_root:
        return "summary"
    if not state.candidate_queue:
        # If queue is empty but we aren't at root, it means we found an ancestor
        # and need to move to the next level of the search.
        return "filter"
    # Otherwise, continue processing the current queue
    return "evaluate"

# Define the graph
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
    
