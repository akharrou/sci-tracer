import unittest
from unittest.mock import patch, MagicMock
from src.tools import search_paper, get_references
from src.schemas import Paper

class TestTools(unittest.TestCase):

    @patch('src.tools.requests.get')
    def test_search_paper_success(self, mock_get):
        # Mock response data
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": [{
                "paperId": "12345",
                "title": "Test Paper",
                "year": 2023,
                "citationCount": 100,
                "abstract": "This is a test abstract.",
                "url": "http://example.com"
            }]
        }
        mock_get.return_value = mock_response

        paper = search_paper("Test Paper")
        
        self.assertIsNotNone(paper)
        self.assertEqual(paper.paper_id, "12345")
        self.assertEqual(paper.title, "Test Paper")
        self.assertEqual(paper.year, 2023)

    @patch('src.tools.requests.get')
    def test_get_references_success(self, mock_get):
        # Mock response data
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": [
                {
                    "citedPaper": {
                        "paperId": "ref1",
                        "title": "Reference 1",
                        "year": 2020,
                        "citationCount": 50
                    }
                },
                {
                    "citedPaper": {
                        "paperId": "ref2",
                        "title": "Reference 2",
                        "year": 2019,
                        "citationCount": 30
                    }
                }
            ]
        }
        mock_get.return_value = mock_response

        refs = get_references("12345")
        
        self.assertEqual(len(refs), 2)
        self.assertEqual(refs[0].paper_id, "ref1")
        self.assertEqual(refs[1].title, "Reference 2")

if __name__ == '__main__':
    unittest.main()
