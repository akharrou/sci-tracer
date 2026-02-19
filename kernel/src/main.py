import os
import argparse
import sys
import logging
import uuid
from dotenv import load_dotenv

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# Ensure the kernel/src directory is in the path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.brain import app
from src.schemas import AgentState

load_dotenv()

import uuid

# ... (imports)

def main():
    parser = argparse.ArgumentParser(description="Sci-Trace: Autonomous Scientific Lineage Mapper")
    parser.add_argument("--topic", type=str, required=True, help="The scientific topic or paper to trace.")
    parser.add_argument("--max_depth", type=int, default=5, help="Maximum search depth.")
    
    args = parser.parse_args()

    # Initialize state
    trace_id = str(uuid.uuid4())
    initial_state = AgentState(
        target_topic=args.topic,
        trace_id=trace_id,
        max_depth=args.max_depth,
        depth=0,
        history=[],
        found_root=False
    )

    # Execute graph
    try:
        app.invoke(initial_state)
    except Exception as e:
        import traceback
        error_msg = str(e)
        logger.error(f"Kernel Failure: {traceback.format_exc()}")
        print(f"[UI:ERROR] Kernel encountered an unhandled exception: {error_msg}")
        sys.exit(1)

if __name__ == "__main__":
    main()
