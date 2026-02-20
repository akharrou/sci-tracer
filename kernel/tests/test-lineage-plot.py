import os
import sys
from pathlib import Path

# Add the project root to sys.path so we can import our modules
sys.path.append(str(Path(__file__).parent.parent))

from src.schemas import Paper, LineageStep, AgentState
from src.brain import plot_node

def generate_mock_lineage():
    # Define mock papers
    p0 = Paper(paperId="fa22", title="FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness", year=2022, citationCount=1500)
    p1 = Paper(paperId="sa21", title="Self-attention Does Not Need O(n^2) Memory", year=2021, citationCount=850)
    p2 = Paper(paperId="attn17", title="Attention Is All You Need", year=2017, citationCount=115000)
    p3 = Paper(paperId="gnmt16", title="Google's Neural Machine Translation System: Bridging the Gap between Human and Machine Translation", year=2016, citationCount=14000)
    p4 = Paper(paperId="eff15", title="Effective Approaches to Attention-based Neural Machine Translation", year=2015, citationCount=9500)
    p5 = Paper(paperId="joint14", title="Neural Machine Translation by Jointly Learning to Align and Translate", year=2014, citationCount=28000)
    p6 = Paper(paperId="s2s14", title="Sequence to Sequence Learning with Neural Networks", year=2014, citationCount=35000)

    # Build history steps
    history = [
        LineageStep(current_paper=p0, parent_paper=p1, reasoning="Methodological precursor for memory efficiency.", confidence_score=0.95),
        LineageStep(current_paper=p1, parent_paper=p2, reasoning="Foundation of self-attention mechanisms.", confidence_score=0.98),
        LineageStep(current_paper=p2, parent_paper=p3, reasoning="Evolution of NMT architectures.", confidence_score=0.92),
        LineageStep(current_paper=p3, parent_paper=p4, reasoning="Earlier attention-based translation refinement.", confidence_score=0.88),
        LineageStep(current_paper=p4, parent_paper=p5, reasoning="Introduction of joint learning and alignment.", confidence_score=0.94),
        LineageStep(current_paper=p5, parent_paper=p6, reasoning="Core seq2seq foundation.", confidence_score=0.96),
    ]

    # Create mock state
    state = AgentState(
        target_topic="FlashAttention",
        trace_id="flash_test_001",
        history=history,
        depth=6
    )

    # Run the plot node
    plot_node(state)
    
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    artifact_path = os.path.join(base_dir, "artifacts", "trace_flash_test_001.png")
    if os.path.exists(artifact_path):
        print(f"SUCCESS: Mock lineage image generated at {artifact_path}")
    else:
        print("FAILURE: Image was not generated.")

if __name__ == "__main__":
    generate_mock_lineage()
