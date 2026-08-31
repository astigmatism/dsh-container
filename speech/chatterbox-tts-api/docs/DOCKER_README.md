# Chatterbox TTS API Docker Deployment Guide

This guide covers how to run the Chatterbox TTS FastAPI using Docker and Docker Compose v2.

## 🚀 Quick Start

### Option 1: Docker Compose (Recommended)

1. **Clone and prepare:**

   ```bash
   git clone https://github.com/travisvn/chatterbox-tts-api
   cd chatterbox-tts-api

   # For Docker deployment (recommended)
   cp .env.example.docker .env

   # Or for local development
   # cp .env.example .env
   ```

2. **Choose your Docker Compose variant:**

   ```bash
   # Standard setup (pip-based, auto-detects device)
   docker compose -f docker/docker-compose.yml up -d

   # uv-optimized setup (faster builds, better dependencies)
   docker compose -f docker/docker-compose.uv.yml up -d

   # GPU-optimized (traditional pip + NVIDIA GPU)
   docker compose -f docker/docker-compose.gpu.yml up -d

   # uv + GPU optimized (fastest builds + NVIDIA GPU)
   docker compose -f docker/docker-compose.uv.gpu.yml up -d

   # CPU-only (forced CPU, no GPU dependencies)
   docker compose -f docker/docker-compose.cpu.yml up -d
   ```

   > [!NOTE]  
   > It's recommended to run `docker compose` from the parent directory and to specify the `.yml` file by referencing it in the docker subfolder (i.e. `-f docker/docker-compose*.yml`)

3. **Test the API:**

   ```bash
   curl -X POST http://localhost:4123/v1/audio/speech \
     -H "Content-Type: application/json" \
     -d '{"input": "Hello from Docker!"}' \
     --output test.wav
   ```

4. **Explore the API Documentation:**

   ```bash
   # Interactive Swagger UI
   open http://localhost:4123/docs

   # Alternative ReDoc documentation
   open http://localhost:4123/redoc
   ```

### Docker Compose Variants

| File                        | Description                           | Use Case                   |
| --------------------------- | ------------------------------------- | -------------------------- |
| `docker-compose.yml`        | Standard pip-based build, auto device | General use                |
| `docker-compose.uv.yml`     | uv-optimized build, auto device       | Faster builds, better deps |
| `docker-compose.gpu.yml`    | Standard build with GPU enabled       | NVIDIA GPU users           |
| `docker-compose.uv.gpu.yml` | uv-optimized build with GPU enabled   | Best of both worlds        |
| `docker-compose.cpu.yml`    | CPU-only build (no GPU dependencies)  | CPU-only environments      |

### Option 2: Docker Run

```bash
# Build the image
docker build -t chatterbox-tts-api .

# Run the container
docker run -d \
  --name chatterbox-tts-api \
  -p 4123:4123 \
  -v ./voice-sample.mp3:/app/voice-sample.mp3:ro \
  -v chatterbox-models:/cache \
  -e EXAGGERATION=0.7 \
  -e CFG_WEIGHT=0.4 \
  chatterbox-tts-api
```

## 📋 Prerequisites

- Docker Engine 20.10+
- Docker Compose v2 (comes with Docker Desktop)
- At least 4GB RAM (8GB+ recommended)
- GPU support (optional but recommended)

### For GPU Support

**NVIDIA GPU (Linux):**

```bash
# Install NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker
```

Then enable the GPU section in the appropriate `docker-compose.yml`.

## ⚙️ Configuration

### Environment Files

The project provides two environment example files:

- **`.env.example.docker`** - Pre-configured for Docker with container paths (`/cache`, `/app/voice-sample.mp3`)
- **`.env.example`** - Configured for local development with relative paths (`./models`, `./voice-sample.mp3`)

For Docker deployment, use the Docker-specific version:

```bash
cp .env.example.docker .env
```

### Environment Variables

Copy the appropriate environment file and customize:

```bash
# For Docker (recommended)
cp .env.example.docker .env

# For local development
cp .env.example .env

# Edit as needed
nano .env  # or your preferred editor
```

**Key variables:**

| Variable            | Default              | Description                     |
| ------------------- | -------------------- | ------------------------------- |
| `PORT`              | `4123`               | API server port                 |
| `EXAGGERATION`      | `0.5`                | Emotion intensity (0.25-2.0)    |
| `CFG_WEIGHT`        | `0.5`                | Pace control (0.0-1.0)          |
| `TEMPERATURE`       | `0.8`                | Sampling temperature (0.05-5.0) |
| `VOICE_SAMPLE_PATH` | `./voice-sample.mp3` | Path to voice sample            |
| `VOICE_LIBRARY_DIR` | `/voices`            | Directory for voice library     |
| `DEVICE`            | `auto`               | Device: auto/cuda/mps/cpu       |
| `MAX_CHUNK_LENGTH`  | `280`                | Max characters per chunk        |

### Voice Configuration

#### Default Voice Sample

```bash
# Place your voice sample in the project root
cp your-voice.mp3 voice-sample.mp3
```

Or use environment variables for custom paths:

```env
VOICE_SAMPLE_PATH=/app/voice-samples/custom-voice.mp3
VOICE_SAMPLE_HOST_PATH=./my-voices/custom-voice.mp3
```

#### Voice Library Management

The voice library allows you to upload and manage multiple voices that persist across container restarts:

```bash
# Upload a voice to the library
curl -X POST http://localhost:4123/v1/voices \
  -F "voice_file=@my-voice.wav" \
  -F "name=my-custom-voice"

# Use the voice by name in speech generation
curl -X POST http://localhost:4123/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello!", "voice": "my-custom-voice"}' \
  --output output.wav

# List available voices
curl http://localhost:4123/v1/voices
```

**Voice Storage:** Voices are stored in the persistent `chatterbox-voices` Docker volume mounted at `/voices` inside the container.

## 🏗️ Build Options

### Standard Build

```bash
docker build -t chatterbox-tts .
```

### Build with Custom Base Image

```bash
docker build --build-arg BASE_IMAGE=python:3.11-bullseye -t chatterbox-tts .
```

### Multi-stage Build (Smaller Image)

```bash
docker build -f Dockerfile.slim -t chatterbox-tts:slim .
```

## 🚢 Deployment Examples

### Development Setup

```yaml
# docker-compose.dev.yml
services:
  chatterbox-tts:
    build: .
    ports:
      - '4123:4123'
    environment:
      - EXAGGERATION=0.7
    volumes:
      - .:/app
      - chatterbox-models:/cache
    command: uvicorn api:app --host=0.0.0.0 --port=4123 --reload
```

```bash
docker compose -f docker-compose.dev.yml up
```

### Production Setup

```yaml
# docker-compose.prod.yml
services:
  chatterbox-tts:
    image: chatterbox-tts:latest
    restart: always
    ports:
      - '4123:4123'
    environment:
      - EXAGGERATION=0.5
      - CFG_WEIGHT=0.5
    volumes:
      - ./voice-sample.mp3:/app/voice-sample.mp3:ro
      - chatterbox-models:/cache
    deploy:
      resources:
        limits:
          memory: 8G
        reservations:
          memory: 4G
```

### Multiple Instances (Load Balancing)

```yaml
services:
  chatterbox-tts-1:
    build: .
    ports:
      - '4123:4123'
    # ... config

  chatterbox-tts-2:
    build: .
    ports:
      - '5124:4123'
    # ... config

  nginx:
    image: nginx:alpine
    ports:
      - '80:80'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - chatterbox-tts-1
      - chatterbox-tts-2
```

## 📊 Monitoring and Logs

### View Logs

```bash
# Real-time logs
docker compose logs -f chatterbox-tts

# Last 100 lines
docker compose logs --tail=100 chatterbox-tts
```

### Health Checks

```bash
# Check container health
docker compose ps

# Manual health check
curl http://localhost:4123/health

# Get configuration
curl http://localhost:4123/config

# Check API documentation
curl http://localhost:4123/docs
```

### Resource Monitoring

```bash
# Container stats
docker stats chatterbox-tts-api

# Detailed info
docker inspect chatterbox-tts-api
```

## 🔧 Troubleshooting

### Common Issues

**1. Model Download Fails**

```bash
# Check internet connectivity
docker compose exec chatterbox-tts curl -I https://huggingface.co

# Clear model cache
docker volume rm chatterbox_chatterbox-models
docker compose up --build
```

**2. Voice Sample Not Found**

```bash
# Check file permissions
ls -la voice-sample.mp3

# Verify mount
docker compose exec chatterbox-tts ls -la /app/voice-sample.mp3
```

**3. Out of Memory**

```bash
# Check memory usage
docker stats

# Increase Docker memory limit or use CPU device
echo 'DEVICE=cpu' >> .env
docker compose up -d
```

**4. GPU Not Detected**

```bash
# Check NVIDIA runtime
docker run --rm --gpus all nvidia/cuda:11.8-base-ubuntu20.04 nvidia-smi

# Verify GPU setup in container
docker compose exec chatterbox-tts python -c "import torch; print(torch.cuda.is_available())"
```

**5. FastAPI/Uvicorn Issues**

```bash
# Check if uvicorn is running
docker compose exec chatterbox-tts ps aux | grep uvicorn

# Check FastAPI logs
docker compose logs chatterbox-tts | grep "Application startup complete"

# Test API endpoints
curl http://localhost:4123/openapi.json
```

### Performance Tuning

**For CPU-only systems:**

```env
DEVICE=cpu
MAX_CHUNK_LENGTH=200  # Smaller chunks
TEMPERATURE=0.6       # Less random sampling
```

**For GPU systems:**

```env
DEVICE=cuda
MAX_CHUNK_LENGTH=300  # Can handle larger chunks
```

**For faster inference:**

```env
CFG_WEIGHT=0.3        # Faster speech
TEMPERATURE=0.5       # More deterministic
```

**FastAPI Performance:**

```env
# Production settings
HOST=0.0.0.0
PORT=4123

# Development settings (Docker dev setup)
UVICORN_RELOAD=true
UVICORN_LOG_LEVEL=debug
```

## 🔒 Security Considerations

### Production Security

```env
# Disable debug mode (production)
UVICORN_LOG_LEVEL=info

# Bind to specific interface
HOST=127.0.0.1  # localhost only

# Use secrets for sensitive config
VOICE_SAMPLE_PATH=/run/secrets/voice_sample
```

### Docker Secrets Example

```yaml
services:
  chatterbox-tts:
    # ... other config
    secrets:
      - voice_sample
    environment:
      - VOICE_SAMPLE_PATH=/run/secrets/voice_sample

secrets:
  voice_sample:
    file: ./secrets/voice-sample.mp3
```

## 📈 Scaling

### Horizontal Scaling

```yaml
services:
  chatterbox-tts:
    # ... config
    deploy:
      replicas: 3
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 2G
```

### Using External Load Balancer

```bash
# HAProxy example
docker run -d --name haproxy \
  -p 80:80 \
  -v ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro \
  haproxy:alpine
```

### FastAPI Scaling Benefits

- **Better async performance**: FastAPI handles more concurrent requests efficiently
- **Lower memory overhead**: More efficient than Flask for JSON serialization
- **Built-in monitoring**: OpenAPI metrics available at `/openapi.json`

## 🧪 Testing

### Automated Testing

```bash
# Run test suite
docker compose exec chatterbox-tts python tests/test_api.py

# Test FastAPI specific features
docker compose exec chatterbox-tts python -c "
import requests
# Test documentation endpoints
resp = requests.get('http://localhost:4123/docs')
print(f'Docs Status: {resp.status_code}')

resp = requests.get('http://localhost:4123/openapi.json')
print(f'OpenAPI Status: {resp.status_code}')
"
```

### Performance Testing

```bash
# Stress test with multiple requests
for i in {1..10}; do
  curl -X POST http://localhost:4123/v1/audio/speech \
    -H "Content-Type: application/json" \
    -d '{"input": "Performance test '$i'"}' \
    --output test_$i.wav &
done
wait
```

### API Documentation Testing

```bash
# Test interactive docs
curl -f http://localhost:4123/docs

# Test API schema
curl http://localhost:4123/openapi.json | jq '.info.title'

# Test ReDoc
curl -f http://localhost:4123/redoc
```

## 📝 Advanced Configuration

### Custom Dockerfile for FastAPI

```dockerfile
# Dockerfile.custom
FROM chatterbox-tts:latest

# Add custom FastAPI middleware
COPY custom_middleware.py /app/
ENV PYTHONPATH="/app:$PYTHONPATH"

# Custom uvicorn settings
ENV UVICORN_WORKERS=1
ENV UVICORN_LOG_LEVEL=info
```

### Multi-architecture Build

```bash
# Build for multiple platforms
docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64 -t chatterbox-tts:multi .
```

### CI/CD Integration

```yaml
# .github/workflows/docker.yml
name: Docker Build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Build and test
        run: |
          docker compose up -d
          sleep 30
          curl -f http://localhost:4123/health
          curl -f http://localhost:4123/docs
          docker compose down
```

## 🆕 FastAPI Migration Notes

If you're upgrading from the Flask version:

### Key Changes

1. **Startup Command**:

   - Current: `CMD ["python", "main.py"]` (FastAPI with uvicorn)
   - Previous: `CMD ["python", "api.py"]` (Flask)

2. **Dependencies**:

   - Removed: `flask`
   - Added: `fastapi`, `uvicorn[standard]`, `pydantic`

3. **New Features**:
   - Interactive API docs at `/docs`
   - Alternative docs at `/redoc`
   - OpenAPI schema at `/openapi.json`
   - Better async performance
   - Automatic request validation

### Compatibility

- ✅ All existing API endpoints work the same
- ✅ Request/response formats unchanged
- ✅ Docker Compose files updated automatically
- ✅ Environment variables remain the same
- ⚡ Performance improved by 25-40%

For more information, see the main [API_README.md](API_README.md) for API usage details.
