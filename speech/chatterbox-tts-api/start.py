#!/usr/bin/env python3
"""
Development startup script for Chatterbox TTS API

This script provides convenient ways to start the API in development mode.
"""

import sys
import subprocess
import argparse
from pathlib import Path


def start_dev():
    """Start the API in development mode with auto-reload"""
    print("🚀 Starting Chatterbox TTS API in development mode...")
    cmd = [
        "uvicorn",
        "app.main:app",
        "--host", "0.0.0.0",
        "--port", "4123",
        "--reload",
        "--log-level", "debug"
    ]
    subprocess.run(cmd)


def start_prod():
    """Start the API in production mode"""
    print("🚀 Starting Chatterbox TTS API in production mode...")
    cmd = ["python", "main.py"]
    subprocess.run(cmd)


def start_fullstack():
    """Start the full stack (API + Frontend) with Docker Compose"""
    print("🚀 Starting Chatterbox TTS API Full Stack (API + Frontend)...")
    cmd = ["docker", "compose", "-f", "docker/docker-compose.yml", "--profile", "frontend", "up", "--build"]
    subprocess.run(cmd)


def test_api():
    """Run the API test suite"""
    print("🧪 Running API test suite...")
    cmd = ["python", "tests/test_api.py"]
    subprocess.run(cmd)


def test_memory():
    """Run the memory test suite"""
    print("🧠 Running memory test suite...")
    cmd = ["python", "tests/test_memory.py"]
    subprocess.run(cmd)


def show_info():
    """Show project structure and helpful information"""
    print("📁 Chatterbox TTS API Project Structure:")
    print("""
app/
├── __init__.py           # Main package
├── config.py            # Configuration management
├── main.py              # FastAPI application
├── models/              # Pydantic models
│   ├── requests.py      # Request models
│   └── responses.py     # Response models
├── core/                # Core functionality
│   ├── memory.py        # Memory management
│   ├── text_processing.py # Text processing utilities
│   └── tts_model.py     # TTS model management
└── api/                 # API endpoints
    ├── router.py        # Main router
    └── endpoints/       # Individual endpoint modules
        ├── speech.py    # TTS endpoint
        ├── health.py    # Health check
        ├── models.py    # Model listing
        ├── memory.py    # Memory management
        └── config.py    # Configuration

docker/                  # Docker files consolidated
├── Dockerfile          # Standard Docker image
├── Dockerfile.uv       # uv-optimized image
├── Dockerfile.gpu      # GPU-enabled image
├── Dockerfile.cpu      # CPU-only image
├── Dockerfile.uv.gpu   # uv + GPU image
├── docker-compose.yml  # Standard deployment
├── docker-compose.uv.yml # uv deployment
├── docker-compose.gpu.yml # GPU deployment
├── docker-compose.uv.gpu.yml # uv + GPU deployment
└── docker-compose.cpu.yml # CPU-only deployment

tests/                   # Test suite
├── test_api.py         # API tests
└── test_memory.py      # Memory tests

main.py                  # Entry point
start.py                 # This development script
""")
    
    print("\n🔗 Useful endpoints:")
    print("  • API Documentation: http://localhost:4123/docs")
    print("  • Alternative Docs: http://localhost:4123/redoc") 
    print("  • Health Check: http://localhost:4123/health")
    print("  • Memory Info: http://localhost:4123/memory")
    print("  • Configuration: http://localhost:4123/config")


def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS API Development Helper")
    parser.add_argument("command", choices=["dev", "prod", "test", "test-memory", "info", "fullstack"], 
                       help="Command to execute")
    
    args = parser.parse_args()
    
    if args.command == "dev":
        start_dev()
    elif args.command == "prod":
        start_prod()
    elif args.command == "fullstack":
        start_fullstack()
    elif args.command == "test":
        test_api()
    elif args.command == "test-memory":
        test_memory()
    elif args.command == "info":
        show_info()


if __name__ == "__main__":
    main() 