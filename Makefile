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
