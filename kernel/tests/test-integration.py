import unittest
from unittest.mock import patch, MagicMock, AsyncMock
import asyncio
import json
from src.brain import app
from src.schemas import AgentState, Paper, CitationDecision

class TestKernelIntegration(unittest.IsolatedAsyncioTestCase):
    """
    Integration tests for the LangGraph research kernel.
    Mocks external APIs to verify the state machine's logic.
    """

    @patch('src.tools.requests.get')
    @patch('src.brain.eval_agent.run')
    @patch('src.brain.summary_agent.run')
    async def test_full_lineage_flow(self, mock_summary_run, mock_eval_run, mock_ss_get):
        # 1. Mock Semantic Scholar Search (Self-RAG)
        mock_response_search = MagicMock()
        mock_response_search.status_code = 200
        mock_response_search.json.return_value = {
            "data": [{
                "paperId": "self-rag-2023",
                "title": "Self-RAG: Learning to Retrieve, Generate, and Critique",
                "year": 2023,
                "citationCount": 100,
                "abstract": "We introduce Self-RAG.",
                "url": "http://example.com/self-rag"
            }]
        }
        
        # 2. Mock Semantic Scholar References (RAG-2020)
        mock_response_refs = MagicMock()
        mock_response_refs.status_code = 200
        mock_response_refs.json.return_value = {
            "data": [{
                "citedPaper": {
                    "paperId": "rag-2020",
                    "title": "Retrieval-Augmented Generation for Knowledge-Intensive Tasks",
                    "year": 2020,
                    "citationCount": 500,
                    "abstract": "We present RAG."
                }
            }]
        }

        mock_ss_get.side_effect = [mock_response_search, mock_response_refs, mock_response_refs]

        # 3. Mock LLM Citation Decision (Picking RAG-2020)
        # We need a real CitationDecision object for Pydantic validation
        mock_decision = CitationDecision(
            selected_paper_id="rag-2020",
            reasoning_trace="RAG is the direct ancestor.",
            is_foundational=True,
            confidence=1.0
        )
        
        mock_eval_result = MagicMock()
        mock_eval_result.output = mock_decision
        mock_eval_run.return_value = mock_eval_result

        # 4. Mock Summary Agent
        mock_summary_result = MagicMock()
        mock_summary_result.output = "Summary of the research journey."
        mock_summary_run.return_value = mock_summary_result

        initial_state = AgentState(
            target_topic="Self-RAG",
            trace_id="test-trace",
            max_depth=2,
            depth=0,
            history=[],
            found_root=False
        )

        # Execute the graph
        final_state = await app.ainvoke(initial_state)

        # Assertions
        self.assertEqual(final_state['depth'], 1)
        self.assertEqual(len(final_state['history']), 1)
        self.assertEqual(final_state['history'][0].parent_paper.paper_id, "rag-2020")
        self.assertTrue(final_state['found_root'])
        self.assertIsNotNone(final_state['final_summary'])
        
        print("✅ Kernel Integration flow passed.")

if __name__ == '__main__':
    unittest.main()
