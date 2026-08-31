# Chatterbox TTS API - Makefile for Development and Testing

.PHONY: help install test test-quick test-all test-api test-memory test-regression test-voice test-status test-coverage test-html clean lint format dev-install

# Default target
help:
	@echo "Chatterbox TTS API - Development Commands"
	@echo "========================================"
	@echo ""
	@echo "Setup:"
	@echo "  install        Install dependencies"
	@echo "  dev-install    Install with development dependencies"
	@echo ""
	@echo "Testing:"
	@echo "  test           Run quick tests (default)"
	@echo "  test-quick     Run quick tests (excludes slow tests)"
	@echo "  test-all       Run all tests including slow ones"
	@echo "  test-api       Run API functionality tests only"
	@echo "  test-memory    Run memory management tests only"
	@echo "  test-regression Run regression tests only"
	@echo "  test-voice     Run voice-related tests only"
	@echo "  test-status    Run status monitoring tests only"
	@echo "  test-coverage  Run tests with coverage reporting"
	@echo "  test-html      Run tests and generate HTML report"
	@echo ""
	@echo "Development:"
	@echo "  lint           Run code linting"
	@echo "  format         Format code"
	@echo "  clean          Clean test outputs and cache"
	@echo "  start          Start the API server"
	@echo ""
	@echo "CI/CD:"
	@echo "  ci-test        Run tests suitable for CI"
	@echo "  ci-coverage    Run tests with coverage for CI"

# Installation targets
install:
	@echo "📦 Installing dependencies..."
	@if command -v uv >/dev/null 2>&1; then \
		echo "Using uv for faster installation..."; \
		uv sync; \
	else \
		echo "Using pip..."; \
		pip install -e .; \
	fi

dev-install:
	@echo "📦 Installing with development dependencies..."
	@if command -v uv >/dev/null 2>&1; then \
		echo "Using uv for faster installation..."; \
		uv sync --group test; \
	else \
		echo "Using pip..."; \
		pip install -e ".[test]"; \
	fi

# Test targets
test: test-quick

test-quick:
	@echo "🧪 Running quick tests..."
	python tests/run_tests.py --quick

test-all:
	@echo "🧪 Running all tests (including slow tests)..."
	python tests/run_tests.py --all

test-api:
	@echo "🌐 Running API tests..."
	python tests/run_tests.py --api-only

test-memory:
	@echo "💾 Running memory tests..."
	python tests/run_tests.py --memory

test-regression:
	@echo "🔄 Running regression tests..."
	python tests/run_tests.py --regression

test-voice:
	@echo "🎤 Running voice tests..."
	python tests/run_tests.py --voice

test-status:
	@echo "📊 Running status tests..."
	python tests/run_tests.py --status

test-coverage:
	@echo "📈 Running tests with coverage..."
	python tests/run_tests.py --coverage

test-html:
	@echo "📄 Running tests with HTML report..."
	python tests/run_tests.py --html-report --coverage

# CI/CD targets
ci-test:
	@echo "🤖 Running CI tests..."
	python tests/run_tests.py --quick --junit-xml --no-header

ci-coverage:
	@echo "🤖 Running CI tests with coverage..."
	python tests/run_tests.py --coverage --junit-xml --no-header

# Development targets
start:
	@echo "🚀 Starting API server..."
	python main.py

lint:
	@echo "🔍 Running linting..."
	@if command -v flake8 >/dev/null 2>&1; then \
		flake8 app/ tests/; \
	else \
		echo "flake8 not installed, skipping linting"; \
	fi

format:
	@echo "✨ Formatting code..."
	@if command -v black >/dev/null 2>&1; then \
		black app/ tests/; \
	else \
		echo "black not installed, skipping formatting"; \
	fi

clean:
	@echo "🧹 Cleaning up..."
	rm -rf test_outputs/
	rm -rf htmlcov/
	rm -rf .coverage
	rm -rf test_report.html
	rm -rf test_results.xml
	rm -rf .pytest_cache/
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
	@echo "✅ Cleanup complete"

# Advanced test targets
test-parallel:
	@echo "⚡ Running tests in parallel..."
	python tests/run_tests.py --parallel

test-repeat:
	@echo "🔄 Running tests 3 times for stability..."
	python tests/run_tests.py --repeat 3

test-smoke:
	@echo "💨 Running smoke tests..."
	python tests/run_tests.py -k "test_health"

# Docker targets (if using Docker)
docker-test:
	@echo "🐳 Running tests in Docker..."
	docker-compose -f docker/docker-compose.yml up --build --abort-on-container-exit api-test

# Development workflow targets
dev-setup: dev-install
	@echo "🛠️ Development setup complete!"
	@echo "Run 'make start' to start the API server"
	@echo "Run 'make test' to run tests"

check: lint test-quick
	@echo "✅ Code check complete!"

# Help for specific test categories
test-help:
	@echo "Test Categories:"
	@echo "  Quick tests    - Basic functionality, fast execution"
	@echo "  API tests      - Endpoint testing, error handling"
	@echo "  Memory tests   - Memory usage, cleanup (slow)"
	@echo "  Voice tests    - Voice upload, library management"
	@echo "  Status tests   - Progress tracking, statistics"
	@echo "  Regression     - Backward compatibility"
	@echo ""
	@echo "Advanced Usage:"
	@echo "  python tests/run_tests.py -k 'test_health'  # Run specific test"
	@echo "  python tests/run_tests.py --failfast        # Stop on first failure"
	@echo "  python tests/run_tests.py --verbose         # Detailed output"
	@echo "  python tests/run_tests.py --api-url URL     # Test different API" 