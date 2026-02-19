import pytest
import requests
from src.tools import search_paper, get_references, RateLimitError

def test_search_paper_success(mocker):
    mock_response = mocker.Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "data": [
            {
                "paperId": "abc",
                "title": "Search Result",
                "year": 2021,
                "citationCount": 50,
                "abstract": "An abstract",
                "url": "http://example.com"
            }
        ]
    }
    mocker.patch("requests.get", return_value=mock_response)
    
    paper = search_paper("test topic")
    assert paper is not None
    assert paper.paper_id == "abc"
    assert paper.title == "Search Result"

def test_search_paper_rate_limit(mocker):
    mock_response = mocker.Mock()
    mock_response.status_code = 429
    mocker.patch("requests.get", return_value=mock_response)
    
    # Verify that it raises RateLimitError after retries (or just once if we don't want to wait)
    # Since we use tenacity, it will retry. To keep tests fast, let's mock _make_request or adjust retry settings.
    # For a unit test, mocking the request failure is better.
    with pytest.raises(RateLimitError):
        search_paper("too many requests")

def test_get_references_success(mocker):
    mock_response = mocker.Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "data": [
            {"citedPaper": {"paperId": "ref1", "title": "Ref 1", "year": 2019, "citationCount": 10}},
            {"citedPaper": {"paperId": "ref2", "title": "Ref 2", "year": 2018, "citationCount": 20}}
        ]
    }
    mocker.patch("requests.get", return_value=mock_response)
    
    refs = get_references("abc")
    assert len(refs) == 2
    assert refs[0].paper_id == "ref1"
    assert refs[1].citation_count == 20
