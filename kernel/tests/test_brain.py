import pytest
from src.brain import app
from src.schemas import AgentState, Paper, CitationDecision

def test_graph_search_node(mocker):
    # Mock search_paper
    mock_paper = Paper(paperId="root", title="Root Paper", year=2023, citationCount=10)
    mocker.patch("src.brain.search_paper", return_value=mock_paper)
    
    # We can test individual nodes by calling them
    from src.brain import search_node
    state = AgentState(target_topic="test")
    result = search_node(state)
    
    assert result["current_paper_id"] == "root"
    assert result["depth"] == 0

def test_graph_reason_node_foundational(mocker):
    from src.brain import reason_node
    
    # Mock get_references
    mock_refs = [Paper(paperId="parent", title="Parent Paper", year=2015, citationCount=15000)]
    mocker.patch("src.brain.get_references", return_value=mock_refs)
    
    # Mock LLM agent
    mock_decision = CitationDecision(
        selected_paper_id="parent",
        reasoning_trace="Very foundational",
        is_foundational=True,
        confidence=0.99
    )
    # Mocking the reasoning_agent.run_sync().data
    mock_run_result = mocker.Mock()
    mock_run_result.data = mock_decision
    mocker.patch("src.brain.reasoning_agent.run_sync", return_value=mock_run_result)
    
    state = AgentState(target_topic="test", current_paper_id="root", depth=0)
    result = reason_node(state)
    
    assert result["current_paper_id"] == "parent"
    assert result["found_root"] is True
    assert result["depth"] == 1
