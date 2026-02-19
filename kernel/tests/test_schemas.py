import pytest
from src.schemas import Paper, LineageStep, AgentState

def test_paper_validation():
    data = {
        "paperId": "123",
        "title": "Test Paper",
        "year": 2020,
        "citationCount": 100
    }
    paper = Paper.model_validate(data)
    assert paper.paper_id == "123"
    assert paper.citation_count == 100

def test_agent_state_init():
    state = AgentState(target_topic="AI")
    assert state.target_topic == "AI"
    assert state.depth == 0
    assert state.history == []
