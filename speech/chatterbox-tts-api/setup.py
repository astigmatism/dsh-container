#!/usr/bin/env python3
"""
Chatterbox TTS API - Setup Script
"""

from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

with open("requirements.txt", "r", encoding="utf-8") as fh:
    requirements = [line.strip() for line in fh if line.strip() and not line.startswith("#")]

setup(
    name="chatterbox-tts-api",
    version="2.1.0",
    author="Travis Van Nimwegen",
    author_email="tts@travis2.com",
    description="REST API for Chatterbox TTS with OpenAI compatibility",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/travisvn/chatterbox-tts-api",
    packages=find_packages(),
    license="AGPLv3",
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.11",
        "Topic :: Multimedia :: Sound/Audio :: Speech",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
        "Framework :: FastAPI",
    ],
    python_requires=">=3.11",
    install_requires=requirements,
    entry_points={
        "console_scripts": [
            "chatterbox-tts-api=api:main",
        ],
    },
    include_package_data=True,
    package_data={
        "": ["*.mp3", "*.example", "*.md"],
    },
) 