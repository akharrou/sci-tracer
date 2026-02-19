import os
from google import genai
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    print("GEMINI_API_KEY not found in .env")
    exit(1)

client = genai.Client(api_key=api_key)

try:
    models = client.models.list()
    print("Available Models:")
    for m in models:
        print(f"- {m}")
except Exception as e:
    print(f"Error listing models: {e}")
