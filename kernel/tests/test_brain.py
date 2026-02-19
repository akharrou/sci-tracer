import pytest
import asyncio
from unittest.mock import MagicMock, AsyncMock
from src.brain import search_node, filter_node, evaluate_node, summary_node
from src.schemas import AgentState, Paper, CitationDecision, EvaluationResult, LineageStep

@pytest.mark.asyncio
async def test_search_node(mocker):
    # Mock search_paper
    mock_paper = Paper(paperId="root", title="Root Paper", year=2023, citationCount=10, abstract="Root abstract")
    mocker.patch("src.brain.search_paper", return_value=mock_paper)
    
    state = AgentState(target_topic="test", trace_id="123")
    result = search_node(state)
    
    assert result["current_paper"].paper_id == "root"
    assert result["depth"] == 0
    assert result["history"] == []

@pytest.mark.asyncio
async def test_filter_node(mocker):
    # Mock get_references
    mock_refs = [
        Paper(paperId="ref1", title="Ref 1", year=2020, citationCount=100),
        Paper(paperId="ref2", title="Ref 2", year=2021, citationCount=50),
        Paper(paperId="ref3", title="Ref 3", year=2024, citationCount=200), # Future year
        Paper(paperId="ref4", title="Ref 4", year=2019, citationCount=5),   # Low citation
    ]
    mocker.patch("src.brain.get_references", return_value=mock_refs)
    
    current_paper = Paper(paperId="root", title="Root", year=2023, citationCount=10)
    state = AgentState(target_topic="test", trace_id="123", current_paper=current_paper)
    
    result = filter_node(state)
    
    # Should only have ref1 and ref2 (ref3 is future, ref4 is low citation)
    assert len(result["candidate_queue"]) == 2
    assert result["candidate_queue"][0].paper_id == "ref1" # Sorted by citations
    assert result["candidate_queue"][1].paper_id == "ref2"

@pytest.mark.asyncio
async def test_evaluate_node_match(mocker):
    # Mock eval_agent.run
    mock_decision = CitationDecision(
        selected_paper_id="match_id",
        reasoning_trace="Methodological match",
        is_foundational=False,
        confidence=0.9
    )
    mock_run_result = MagicMock()
    mock_run_result.output = mock_decision
    mocker.patch("src.brain.eval_agent.run", new_callable=AsyncMock, return_value=mock_run_result)
    
    current_paper = Paper(paperId="root", title="Root", year=2023, citationCount=10, abstract="Root abs")
    candidate = Paper(paperId="match_id", title="Match", year=2020, citationCount=50)
    
    state = AgentState(
        target_topic="test", 
        trace_id="123", 
        current_paper=current_paper,
        candidate_queue=[candidate]
    )
    
    # We need to use MAX_EVAL_BATCH_SIZE
    mocker.patch("src.brain.MAX_EVAL_BATCH_SIZE", 1)
    
    result = await evaluate_node(state)
    
    assert result["current_paper"].paper_id == "match_id"
    assert len(result["history"]) == 1
    assert result["candidate_queue"] == []
    assert result["depth"] == 1

@pytest.mark.asyncio
async def test_summary_node(mocker):
    # Mock summary_agent.run
    mock_run_result = MagicMock()
    mock_run_result.output = "The intellectual journey summarized."
    mocker.patch("src.brain.summary_agent.run", new_callable=AsyncMock, return_value=mock_run_result)
    
    paper1 = Paper(paperId="p1", title="Paper 1", year=2010, citationCount=100)
    paper2 = Paper(paperId="p2", title="Paper 2", year=2020, citationCount=50)
    
    step = LineageStep(
        current_paper=paper2,
        parent_paper=paper1,
        reasoning="P1 came first",
        confidence_score=1.0
    )
    
    state = AgentState(
        target_topic="test",
        trace_id="123",
        history=[step]
    )
    
    result = await summary_node(state)
    
    assert "The intellectual journey summarized." in result["final_summary"]
    assert "Paper 1" in result["final_summary"]
    assert "Paper 2" in result["final_summary"]
