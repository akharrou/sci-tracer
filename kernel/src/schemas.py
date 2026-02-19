from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional

class Paper(BaseModel):
    """Represents a single scientific paper from Semantic Scholar."""
    model_config = ConfigDict(populate_by_name=True)
    
    paper_id: Optional[str] = Field(None, alias="paperId")
    title: Optional[str] = "Unknown Title"
    year: Optional[int] = None
    citation_count: int = Field(0, alias="citationCount")
    abstract: Optional[str] = None
    url: Optional[str] = None

class LineageStep(BaseModel):
    """A single hop in the backward lineage graph."""
    current_paper: Paper
    parent_paper: Paper
    reasoning: str = Field(..., description="The Chain-of-Thought explanation for why this parent was selected.")
    confidence_score: float = Field(..., ge=0.0, le=1.0)

class AgentState(BaseModel):
    """The shared state passed between LangGraph nodes."""
    target_topic: str
    trace_id: str = Field(..., description="Unique ID for this specific trace run.")
    current_paper: Optional[Paper] = None
    filtered_candidates: List[Paper] = []
    current_paper_id: Optional[str] = None
    depth: int = 0
    max_depth: int = 5
    history: List[LineageStep] = []
    found_root: bool = False
    final_summary: Optional[str] = None
    error: Optional[str] = None

class CitationDecision(BaseModel):
    """The structured decision returned by the LLM."""
    selected_paper_id: str = Field(..., description="The Semantic Scholar ID of the chosen ancestor.")
    reasoning_trace: str = Field(..., description="A detailed explanation of why this paper is the methodological root.")
    is_foundational: bool = Field(False, description="True if this paper is a seminal work (e.g., >10k citations) and we should stop.")
    confidence: float
