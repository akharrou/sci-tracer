import os
import time
import requests
import logging
from typing import List, Optional
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from dotenv import load_dotenv
from .schemas import Paper

load_dotenv()

SEMANTIC_SCHOLAR_API_KEY = os.getenv("SEMANTIC_SCHOLAR_API_KEY")
MAX_REFERENCES_TO_FETCH = int(os.getenv("MAX_REFERENCES_TO_FETCH", "20"))
BASE_URL = "https://api.semanticscholar.org/graph/v1"

# Configure logging to not interfere with UI tags on stdout
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

class RateLimitError(Exception):
    """Custom exception for 429 Rate Limit errors."""
    pass

# Global variable to track the last request time for rate limiting
LAST_REQUEST_TIME = 0.0
RATE_LIMIT_DELAY = 1.1  # slightly more than 1s to be safe

@retry(
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=2, min=4, max=60), # More aggressive backoff
    retry=retry_if_exception_type((RateLimitError, requests.exceptions.RequestException)),
    reraise=True
)
def _make_request(endpoint: str, params: Optional[dict] = None) -> dict:
    global LAST_REQUEST_TIME
    
    # Proactive rate limiting: Ensure at least 1 second between calls
    elapsed = time.time() - LAST_REQUEST_TIME
    if elapsed < RATE_LIMIT_DELAY:
        time.sleep(RATE_LIMIT_DELAY - elapsed)
    
    headers = {}
    if SEMANTIC_SCHOLAR_API_KEY:
        headers["x-api-key"] = SEMANTIC_SCHOLAR_API_KEY
    
    url = f"{BASE_URL}{endpoint}"
    response = requests.get(url, params=params, headers=headers, timeout=30)
    
    # Update last request time
    LAST_REQUEST_TIME = time.time()
    
    if response.status_code == 429:
        logger.warning("Rate limit hit (429). Retrying...")
        raise RateLimitError("Semantic Scholar Rate Limit Exceeded")
    
    response.raise_for_status()
    return response.json()

def search_paper(query: str) -> Optional[Paper]:
    """Search for a paper by topic and return the most relevant one."""
    params = {
        "query": query,
        "limit": 1,
        "fields": "paperId,title,year,citationCount,abstract,url"
    }
    data = _make_request("/paper/search", params=params)
    if data.get("data"):
        return Paper.model_validate(data["data"][0])
    return None

def get_references(paper_id: str) -> List[Paper]:
    """Fetch references for a given paper ID."""
    params = {
        "limit": MAX_REFERENCES_TO_FETCH,
        "fields": "paperId,title,year,citationCount,abstract,url"
    }
    data = _make_request(f"/paper/{paper_id}/references", params=params)
    papers = []
    if data.get("data"):
        for ref in data["data"]:
            if ref.get("citedPaper"):
                paper_data = ref["citedPaper"]
                # Skip if no ID or no Title
                if not paper_data.get("paperId") or not paper_data.get("title"):
                    continue
                try:
                    papers.append(Paper.model_validate(paper_data))
                except Exception as e:
                    logger.error(f"Error validating paper data: {e}")
    return papers
