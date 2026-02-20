import os
import sys
import pytest
import subprocess
import time
import fcntl
from pathlib import Path

# Add project root to sys.path
sys.path.append(str(Path(__file__).parent.parent))

from src.schemas import AgentState, Paper, LineageStep
from src.brain import plot_node

def test_global_lock_logic():
    """
    Verifies that the file-based lock prevents multiple concurrent executions.
    """
    LOCK_FILE_PATH = "/tmp/sci-trace.lock"
    
    # Ensure lock is clean
    if os.path.exists(LOCK_FILE_PATH):
        try:
            os.remove(LOCK_FILE_PATH)
        except:
            pass

    # Manually acquire the lock
    lock_file = open(LOCK_FILE_PATH, 'w')
    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    
    try:
        # Try to run the main script (it should fail immediately due to the lock)
        # We use the same python interpreter
        result = subprocess.run(
            [sys.executable, "src/main.py", "--topic", "test"],
            capture_output=True,
            text=True
        )
        
        assert result.returncode == 1
        assert "[UI:ERROR] The research engine is currently busy" in result.stdout
        
    finally:
        # Release the manual lock
        fcntl.flock(lock_file, fcntl.LOCK_UN)
        lock_file.close()
        try:
            os.remove(LOCK_FILE_PATH)
        except:
            pass

def test_multiline_output_escaping(capsys):
    """
    Verifies that the plot_node correctly escapes newlines in its final summary output.
    This is critical for Task 10 (Protocol multi-line support).
    """
    p1 = Paper(paperId="p1", title="Paper 1", year=2010, citationCount=100)
    
    # Create a summary with actual newlines
    multi_line_summary = "Line 1\nLine 2\nLine 3"
    
    state = AgentState(
        target_topic="test",
        trace_id="test_escaping",
        history=[LineageStep(current_paper=p1, parent_paper=p1, reasoning="r", confidence_score=1.0)],
        final_summary=multi_line_summary
    )
    
    # Run plot_node which prints [UI:FINAL]
    plot_node(state)
    
    captured = capsys.readouterr()
    
    # The output should contain the tag and the escaped version of the summary
    # We expect [UI:FINAL] followed by the string with literal \n replaced by \\n
    assert "[UI:FINAL] Line 1\\nLine 2\\nLine 3" in captured.out
    
    # It should NOT contain literal newlines within the tag data
    lines = captured.out.split('\n')
    tag_line = [l for l in lines if l.startswith("[UI:FINAL]")][0]
    # The part after [UI:FINAL] should not have raw newlines
    assert "\\n" in tag_line
    assert "\n" not in tag_line[10:]

if __name__ == "__main__":
    pytest.main([__file__])
