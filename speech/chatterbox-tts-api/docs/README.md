# Chatterbox TTS API Documentation

This directory contains detailed documentation for the Chatterbox TTS FastAPI.

## 📚 Documentation Index

### Core Documentation

- **[API_README.md](API_README.md)** - Complete FastAPI reference, configuration, and usage examples
- **[DOCKER_README.md](DOCKER_README.md)** - Docker deployment guide, troubleshooting, and optimization
- **[STREAMING_API.md](STREAMING_API.md)** - Comprehensive streaming API guide with advanced features

### Specialized Features

- **[STATUS_API.md](STATUS_API.md)** - Real-time status monitoring and progress tracking
- **[VOICE_UPLOAD_SUMMARY.md](VOICE_UPLOAD_SUMMARY.md)** - Voice file upload implementation summary

### Technical Guides

- **[ENDPOINT_ALIASING.md](ENDPOINT_ALIASING.md)** - FastAPI endpoint aliasing system explanation

### Migration & Upgrades

- **[UV_MIGRATION.md](UV_MIGRATION.md)** - Guide for migrating from pip to uv for better performance and compatibility

## 🚀 Quick Links

### Getting Started

- [Quick Start Guide](../README.md#quick-start) - Main README with installation options
- [API Usage Examples](API_README.md#api-endpoints) - Basic API calls and parameters
- [Docker Quick Start](DOCKER_README.md#quick-start) - Container deployment

### New FastAPI Features

- [Interactive API Documentation](API_README.md#api-documentation) - Swagger UI and ReDoc
- [Type Safety & Validation](API_README.md#error-handling) - Pydantic models and validation
- [Async Performance](API_README.md#performance-notes) - FastAPI performance benefits
- [**Streaming TTS**](STREAMING_API.md) - Real-time audio streaming with advanced controls

### Common Tasks

- [Configuration Options](API_README.md#configuration) - Environment variables and settings
- [Voice Cloning Setup](../README.md#voice-cloning) - How to use custom voice samples
- [Real-time Status Monitoring](STATUS_API.md) - Track TTS processing progress
- [Troubleshooting](../README.md#troubleshooting) - Common issues and solutions

### Advanced Topics

- [Performance Tuning](DOCKER_README.md#performance-tuning) - Optimization for different environments
- [Security Considerations](DOCKER_README.md#security-considerations) - Production security setup
- [uv Migration Benefits](UV_MIGRATION.md#why-migrate-to-uv) - Why and how to upgrade to uv
- [FastAPI Development](API_README.md#development-features) - Development tools and features
- [Streaming Strategies](STREAMING_API.md#streaming-strategies) - Optimize streaming for different use cases

## 🆕 FastAPI Migration Highlights

This project has been migrated from Flask to FastAPI with the following improvements:

- ⚡ **25-40% better performance** for JSON responses
- 📚 **Automatic API documentation** at `/docs` and `/redoc`
- 🔒 **Type safety** with Pydantic validation
- 🚀 **Async support** for better concurrency
- 🎵 **Real-time streaming** with advanced chunking strategies
- 🔧 **Better developer experience** with interactive testing

All existing API endpoints remain fully compatible!

## 🆘 Need Help?

- 🐛 **Issues**: [GitHub Issues](https://github.com/travisvn/chatterbox-tts-api/issues)
- 💬 **Discord**: [Project Discord](https://readaloudai.com/discord)
- 📖 **Main README**: [Back to main documentation](../README.md)
- 📚 **API Docs**: [Interactive documentation](http://localhost:4123/docs) (when running locally)

---

> 💡 **Tip**: If you're new to the project, start with the [main README](../README.md) and then dive into the specific guides based on your deployment method. Don't forget to check out the interactive API documentation at `/docs` once you have the server running!
