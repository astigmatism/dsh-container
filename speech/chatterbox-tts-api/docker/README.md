# Docker Deployment Guide

This directory contains Docker configurations for the Chatterbox TTS API with **optional frontend support**.

## Quick Start

### API Only (Recommended for most users)

```bash
# Standard deployment
docker compose -f docker/docker-compose.yml up -d

# GPU-enabled (if you have NVIDIA GPU)
docker compose -f docker/docker-compose.gpu.yml up -d

# uv-optimized builds (faster dependency resolution)
docker compose -f docker/docker-compose.uv.yml up -d
docker compose -f docker/docker-compose.uv.gpu.yml up -d

# CPU-only (explicit CPU mode)
docker compose -f docker/docker-compose.cpu.yml up -d
```

**API Access:** `http://localhost:4123`

### API + Frontend (Full Stack)

Add `--profile frontend` to any of the above commands:

```bash
# Standard with frontend
docker compose -f docker/docker-compose.yml --profile frontend up -d

# GPU with frontend
docker compose -f docker/docker-compose.gpu.yml --profile frontend up -d

# uv + GPU with frontend (recommended for GPU users)
docker compose -f docker/docker-compose.uv.gpu.yml --profile frontend up -d
```

**Frontend Access:** `http://localhost:4321` (API requests are proxied automatically)

## Configuration

### Environment Variables

Copy the appropriate environment file:

```bash
# For Docker deployment
cp .env.example.docker .env

# For local development
cp .env.example .env
```

### Key Settings

| Variable        | Default | Description                              |
| --------------- | ------- | ---------------------------------------- |
| `PORT`          | `4123`  | API server port (API-only mode)          |
| `FRONTEND_PORT` | `4321`  | Frontend proxy port (frontend mode only) |
| `DEVICE`        | `auto`  | Device (auto/cuda/cpu/mps)               |
| `EXAGGERATION`  | `0.5`   | Voice emotion intensity                  |

## Docker Compose Files

| File                        | Description         | Use Case                      |
| --------------------------- | ------------------- | ----------------------------- |
| `docker-compose.yml`        | Standard deployment | Production, general use       |
| `docker-compose.gpu.yml`    | GPU-enabled         | NVIDIA GPU users              |
| `docker-compose.uv.yml`     | uv package manager  | Faster builds                 |
| `docker-compose.uv.gpu.yml` | uv + GPU            | **Recommended for GPU users** |
| `docker-compose.cpu.yml`    | CPU-only            | Explicit CPU mode             |

## Usage Examples

```bash
# Start API only
docker compose -f docker/docker-compose.yml up -d

# Start with frontend
docker compose -f docker/docker-compose.yml --profile frontend up -d

# Check logs
docker logs chatterbox-tts-api -f

# Stop services
docker compose -f docker/docker-compose.yml down

# Stop with volumes (removes model cache)
docker compose -f docker/docker-compose.yml down -v
```

## Architecture

### API-Only Mode

```
[Docker Host:4123] → [chatterbox-tts-api:4123]
```

### Frontend Mode

```
[Docker Host:4321] → [chatterbox-tts-frontend:80] → [chatterbox-tts-api:4123] (for API calls)
                                                   → [static files served directly]
```

## Profiles Available

- `frontend` - Includes React frontend + Nginx proxy
- `ui` - Alias for frontend
- `fullstack` - Alias for frontend

## Troubleshooting

### Frontend not starting?

Make sure you're using the profile flag:

```bash
# ❌ Wrong - no frontend
docker compose -f docker/docker-compose.yml up -d

# ✅ Correct - includes frontend
docker compose -f docker/docker-compose.yml --profile frontend up -d
```

### Port conflicts?

Adjust ports in your `.env` file:

```bash
PORT=4125           # API port (API-only mode)
FRONTEND_PORT=4322  # Frontend port (frontend mode)
```

### GPU not detected?

Use the GPU-specific compose file:

```bash
docker compose -f docker/docker-compose.gpu.yml --profile frontend up -d
```
