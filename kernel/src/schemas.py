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

class CitationDecision(BaseModel):
    """The structured decision returned by the LLM."""
    selected_paper_id: Optional[str] = Field(None, description="The Semantic Scholar ID of the chosen ancestor.")
    reasoning_trace: str = Field(..., description="A detailed explanation of why this paper is the methodological root.")
    is_foundational: bool = Field(False, description="True if this paper is a seminal work (e.g., >10k citations) and we should stop.")
    confidence: float

class EvaluationResult(BaseModel):
    """Result of a single paper evaluation."""
    paper: Paper
    decision: CitationDecision
    is_match: bool

class AgentState(BaseModel):
    """The shared state passed between LangGraph nodes."""
    target_topic: str
    trace_id: str = Field(..., description="Unique ID for this specific trace run.")
    current_paper: Optional[Paper] = None
    candidate_queue: List[Paper] = Field(default_factory=list, description="Queue of papers awaiting evaluation.")
    evaluation_results: List[EvaluationResult] = Field(default_factory=list, description="Results from a parallel batch.")
    depth: int = 0
    max_depth: int = 5
    history: List[LineageStep] = []
    found_root: bool = False
    final_summary: Optional[str] = None
    error: Optional[str] = None
