import os
import argparse
import sys
import logging
import uuid
import asyncio
import traceback
import fcntl 
import time
from dotenv import load_dotenv

# Configure logging to stderr to keep stdout clean for the [UI:TAG] protocol.
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# Ensure the kernel/src directory is in the path so we can import internal modules.
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.brain import app
from src.schemas import AgentState

load_dotenv()

# --- GLOBAL LOCK CONFIGURATION ---
# Because Sci-Trace runs as a bursty process on a shared EC2 instance, 
# we use a file-based lock to prevent race conditions.
# This ensures that if a user triggers a trace via a Slash Command (Path A) 
# and another user triggers one via OpenClaw (Path B) simultaneously, 
# the second request won't crash the server or corrupt artifacts.
LOCK_FILE_PATH = "/tmp/sci-trace.lock"

def acquire_lock():
    """
    Attempts to acquire an exclusive lock on the system.
    We use fcntl.flock which is a kernel-level lock. This is more reliable 
    than just checking for file existence, as it handles process crashes gracefully.
    """
    try:
        lock_file = open(LOCK_FILE_PATH, 'w')
        # LOCK_EX: Exclusive lock
        # LOCK_NB: Non-blocking (fail immediately if busy)
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock_file
    except IOError:
        # If flock fails with IOError, it means another process holds the lock.
        print(f"[UI:ERROR] The research engine is currently busy. Please try again in a few minutes.")
        sys.exit(1)
    except Exception as e:
        print(f"[UI:ERROR] Failed to manage lock file: {str(e)}")
        sys.exit(1)

def release_lock(lock_file):
    """
    Releases the kernel lock and cleans up the indicator file.
    """
    if lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_UN)
        lock_file.close()
        try:
            os.remove(LOCK_FILE_PATH)
        except OSError:
            pass

def main():
    parser = argparse.ArgumentParser(description="Sci-Trace: Autonomous Scientific Lineage Mapper")
    parser.add_argument("--topic", type=str, required=True, help="The scientific topic or paper to trace.")
    parser.add_argument("--max_depth", type=int, default=5, help="Maximum search depth.")
    
    args = parser.parse_args()

    # We acquire the lock at the absolute beginning of execution.
    lock_fd = acquire_lock()
    
    try:
        # trace_id is used to name generated PNG artifacts, ensuring that 
        # even if artifacts persist, they are uniquely identifiable.
        trace_id = str(uuid.uuid4())
        initial_state = AgentState(
            target_topic=args.topic,
            trace_id=trace_id,
            max_depth=args.max_depth,
            depth=0,
            history=[],
            found_root=False
        )

        async def run_graph():
            try:
                # Invoke the LangGraph state machine.
                await app.ainvoke(initial_state)
            except Exception as e:
                error_msg = str(e)
                logger.error(f"Kernel Failure: {traceback.format_exc()}")
                # Any unhandled exception is caught and emitted via the UI protocol
                # so the Discord user gets a clear failure message.
                print(f"[UI:ERROR] Kernel encountered an unhandled exception: {error_msg}")
                sys.exit(1)

        asyncio.run(run_graph())

    finally:
        # The 'finally' block ensures that the lock is ALWAYS released, 
        # even if the process crashes or is interrupted.
        release_lock(lock_fd)

if __name__ == "__main__":
    main()
