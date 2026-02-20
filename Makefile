# Sci-Trace Makefile

.PHONY: help test-trace install clean

help:
	@echo "Sci-Trace Management Commands:"
	@echo "  make install      - Install dependencies for both Host and Kernel"
	@echo "  make test-trace   - Run a test lineage trace for 'Attention Is All You Need'"
	@echo "  make clean        - Remove artifacts and temporary files"

install:
	@echo "📦 Installing Kernel dependencies..."
	cd kernel && uv pip install -r requirements.txt
	@echo "📦 Installing Host dependencies..."
	cd host && npm install

test-units:
	@echo "🧪 Running Python Unit Tests..."
	@cd kernel && . .venv/bin/activate && \
	export PYTHONPATH=$$PYTHONPATH:. && \
	python -m unittest discover tests

test-host:
	@echo "🧪 Running Host Unit Tests (Discord & Slack)..."
	@node host/tests/v2-unit-tests.js
	@node host/tests/test-ui-platform.js

test-all: test-units test-host
	@echo "🎉 All system tests passed!"

test:
	@echo "🚀 Running Trace for topic: '$(TOPIC)'..."
	@cd kernel && . .venv/bin/activate && \
	export PYTHONPATH=$$PYTHONPATH:. && \
	python src/main.py --topic "$(TOPIC)" --max_depth 3

test-trace:
	@$(MAKE) test TOPIC="Attention Is All You Need"

clean:
	@echo "🧹 Cleaning up artifacts..."
	rm -rf kernel/artifacts/*.png
	rm -rf host/logs/*.log
	@echo "Done."
