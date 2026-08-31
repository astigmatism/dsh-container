# Chatterbox TTS FastAPI

This API provides a **FastAPI**-based web service for the Chatterbox TTS text-to-speech system, designed to be compatible with OpenAI's TTS API format.

## Features

- **OpenAI-compatible API**: Uses similar endpoint structure to OpenAI's text-to-speech API
- **FastAPI Performance**: High-performance async API with automatic documentation
- **Type Safety**: Full Pydantic validation for requests and responses
- **Interactive Documentation**: Automatic Swagger UI and ReDoc generation
- **Automatic text chunking**: Automatically breaks long text into manageable chunks to handle character limits
- **Voice cloning**: Uses the pre-specified `voice-sample.mp3` file for voice conditioning
- **Async Support**: Non-blocking request handling with better concurrency
- **Error handling**: Comprehensive error handling with appropriate HTTP status codes
- **Health monitoring**: Health check endpoint for monitoring service status
- **Environment-based configuration**: Fully configurable via environment variables
- **Docker support**: Ready for containerized deployment

## Setup

### Prerequisites

1. Ensure you have the Chatterbox TTS package installed:

   ```bash
   pip install chatterbox-tts==0.1.2
   ```

2. Install FastAPI and other required dependencies:

   ```bash
   pip install fastapi uvicorn[standard] torchaudio requests python-dotenv
   ```

3. Ensure you have a `voice-sample.mp3` file in the project root directory for voice conditioning

### Configuration

Copy the example environment file and customize it:

```bash
cp .env.example .env
nano .env  # Edit with your preferred settings
```

Key environment variables:

- `PORT=4123` - API server port
- `EXAGGERATION=0.5` - Default emotion intensity (0.25-2.0)
- `CFG_WEIGHT=0.5` - Default pace control (0.0-1.0)
- `TEMPERATURE=0.8` - Default sampling temperature (0.05-5.0)
- `VOICE_SAMPLE_PATH=./voice-sample.mp3` - Path to voice sample file
- `DEVICE=auto` - Device selection (auto/cuda/mps/cpu)

See `.env.example` for all available options.

### Running the API

Start the API server:

```bash
# Method 1: Direct uvicorn (recommended for development)
uvicorn app.main:app --host 0.0.0.0 --port 4123

# Method 2: Using the main script
python main.py

# Method 3: With auto-reload for development
uvicorn app.main:app --host 0.0.0.0 --port 4123 --reload
```

The server will:

- Automatically detect the best available device (CUDA, MPS, or CPU)
- Load the Chatterbox TTS model asynchronously
- Start the FastAPI server on `http://localhost:4123` (or your configured port)
- Provide interactive documentation at `/docs` and `/redoc`

### API Documentation

Once running, you can access:

- **Interactive API Docs (Swagger UI)**: http://localhost:4123/docs
- **Alternative Documentation (ReDoc)**: http://localhost:4123/redoc
- **OpenAPI Schema**: http://localhost:4123/openapi.json

## API Endpoints

### 1. Text-to-Speech Generation

**POST** `/v1/audio/speech`

Generate speech from text using the Chatterbox TTS model.

**Request Body (Pydantic Model):**

```json
{
  "input": "Text to convert to speech",
  "voice": "alloy", // OpenAI voice name or custom voice library name
  "response_format": "wav", // Ignored - always returns WAV
  "speed": 1.0, // Ignored - use model's built-in parameters
  "exaggeration": 0.7, // Optional - override default (0.25-2.0)
  "cfg_weight": 0.4, // Optional - override default (0.0-1.0)
  "temperature": 0.9 // Optional - override default (0.05-5.0)
}
```

**Validation:**

- `input`: Required, 1-3000 characters, automatically trimmed
- `exaggeration`: Optional, 0.25-2.0 range validation
- `cfg_weight`: Optional, 0.0-1.0 range validation
- `temperature`: Optional, 0.05-5.0 range validation

**Response:**

- Content-Type: `audio/wav`
- Binary audio data in WAV format via StreamingResponse

**Example:**

```bash
curl -X POST http://localhost:4123/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello, this is a test of the text to speech system."}' \
  --output speech.wav
```

**With custom parameters:**

```bash
curl -X POST http://localhost:4123/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Dramatic speech!", "exaggeration": 1.2, "cfg_weight": 0.3}' \
  --output dramatic.wav
```

**Using a voice from the voice library:**

```bash
curl -X POST http://localhost:4123/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello with custom voice!", "voice": "my-uploaded-voice"}' \
  --output custom_voice.wav
```

> **Note:** See [Voice Library Management Documentation](VOICE_LIBRARY_MANAGEMENT.md) for complete voice management API details.

### 2. Health Check

**GET** `/health`

Check if the API is running and the model is loaded.

**Response (HealthResponse model):**

```json
{
  "status": "healthy",
  "model_loaded": true,
  "device": "cuda",
  "config": {
    "max_chunk_length": 280,
    "max_total_length": 3000,
    "voice_sample_path": "./voice-sample.mp3",
    "default_exaggeration": 0.5,
    "default_cfg_weight": 0.5,
    "default_temperature": 0.8
  }
}
```

### 3. List Models

**GET** `/v1/models`

List available models (OpenAI API compatibility).

**Response (ModelsResponse model):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "chatterbox-tts-1",
      "object": "model",
      "created": 1677649963,
      "owned_by": "resemble-ai"
    }
  ]
}
```

### 4. Configuration Info

**GET** `/config`

Get current configuration (useful for debugging).

**Response (ConfigResponse model):**

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 4123
  },
  "model": {
    "device": "cuda",
    "voice_sample_path": "./voice-sample.mp3",
    "model_cache_dir": "./models"
  },
  "defaults": {
    "exaggeration": 0.5,
    "cfg_weight": 0.5,
    "temperature": 0.8,
    "max_chunk_length": 280,
    "max_total_length": 3000
  }
}
```

### 5. API Documentation Endpoints

**GET** `/docs` - Interactive Swagger UI documentation  
**GET** `/redoc` - Alternative ReDoc documentation  
**GET** `/openapi.json` - OpenAPI schema specification

## Text Processing

### Automatic Chunking

The API automatically handles long text inputs by:

1. **Character limit**: Splits text longer than the configured chunk size (default: 280 characters)
2. **Sentence preservation**: Attempts to split at sentence boundaries (`.`, `!`, `?`)
3. **Fallback splitting**: If sentences are too long, splits at commas, semicolons, or other natural breaks
4. **Audio concatenation**: Seamlessly combines audio from multiple chunks

### Maximum Limits

- **Soft limit**: Configurable characters per chunk (default: 280)
- **Hard limit**: Configurable total characters (default: 3000)
- **Automatic processing**: No manual intervention required

## Error Handling

FastAPI provides enhanced error handling with automatic validation:

- **422 Unprocessable Entity**: Invalid input validation (Pydantic errors)
- **400 Bad Request**: Business logic errors (text too long, etc.)
- **500 Internal Server Error**: Model or processing errors

**Error Response Format:**

```json
{
  "error": {
    "message": "Missing required field: 'input'",
    "type": "invalid_request_error"
  }
}
```

**Validation Error Example:**

```json
{
  "detail": [
    {
      "type": "greater_equal",
      "loc": ["body", "exaggeration"],
      "msg": "Input should be greater than or equal to 0.25",
      "input": 0.1
    }
  ]
}
```

## Testing

Use the enhanced test script to verify the API functionality:

```bash
python tests/test_api.py
```

The test script will:

- Test health check endpoint
- Test models endpoint
- Test API documentation endpoints (new!)
- Generate speech for various text lengths
- Test custom parameter validation
- Test error handling with validation
- Save generated audio files as `test_output_*.wav`

## Configuration

You can configure the API through environment variables or by modifying `.env.example`:

```bash
# Server Configuration
PORT=4123
HOST=0.0.0.0

# TTS Model Settings
EXAGGERATION=0.5          # Emotion intensity (0.25-2.0)
CFG_WEIGHT=0.5            # Pace control (0.0-1.0)
TEMPERATURE=0.8           # Sampling temperature (0.05-5.0)

# Text Processing
MAX_CHUNK_LENGTH=280      # Characters per chunk
MAX_TOTAL_LENGTH=3000     # Total character limit

# Voice and Model Settings
VOICE_SAMPLE_PATH=./voice-sample.mp3
VOICE_LIBRARY_DIR=./voices
DEVICE=auto               # auto/cuda/mps/cpu
MODEL_CACHE_DIR=./models
```

### Parameter Effects

**Exaggeration (0.25-2.0):**

- `0.3-0.4`: Very neutral, professional
- `0.5`: Neutral (default)
- `0.7-0.8`: More expressive
- `1.0+`: Very dramatic (may be unstable)

**CFG Weight (0.0-1.0):**

- `0.2-0.3`: Faster speech
- `0.5`: Balanced (default)
- `0.7-0.8`: Slower, more deliberate

**Temperature (0.05-5.0):**

- `0.4-0.6`: More consistent
- `0.8`: Balanced (default)
- `1.0+`: More creative/random

## Docker Deployment

For Docker deployment, see [DOCKER_README.md](DOCKER_README.md) for complete instructions.

**Quick start with Docker Compose:**

```bash
cp .env.example .env  # Customize as needed
docker compose up -d
```

**Quick start with Docker:**

```bash
docker build -t chatterbox-tts .
docker run -d -p 4123:4123 \
  -v ./voice-sample.mp3:/app/voice-sample.mp3:ro \
  -e EXAGGERATION=0.7 \
  chatterbox-tts
```

## Performance Notes

**FastAPI Benefits:**

- **Async performance**: Better handling of concurrent requests
- **Faster JSON serialization**: ~25% faster than Flask
- **Type validation**: Prevents invalid requests at the API level
- **Auto documentation**: No manual API doc maintenance

**Hardware Recommendations:**

- **Model loading**: The model is loaded once at startup (can take 30-60 seconds)
- **First request**: May be slower due to initial model warm-up
- **Subsequent requests**: Should be faster due to model caching
- **Memory usage**: Varies by device (GPU recommended for best performance)
- **Concurrent requests**: FastAPI async support allows better multi-request handling

## Integration Examples

### Python with requests

```python
import requests

# Basic request
response = requests.post(
    "http://localhost:4123/v1/audio/speech",
    json={"input": "Hello world!"}
)

with open("output.wav", "wb") as f:
    f.write(response.content)

# With custom parameters and validation
response = requests.post(
    "http://localhost:4123/v1/audio/speech",
    json={
        "input": "Exciting news!",
        "exaggeration": 0.8,
        "cfg_weight": 0.4,
        "temperature": 1.0
    }
)

# Handle validation errors
if response.status_code == 422:
    print("Validation error:", response.json())
```

### JavaScript/Node.js

```javascript
const response = await fetch('http://localhost:4123/v1/audio/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input: 'Hello world!',
    exaggeration: 0.7,
  }),
});

if (response.status === 422) {
  const error = await response.json();
  console.log('Validation error:', error);
} else {
  const audioBuffer = await response.arrayBuffer();
  // Save or play the audio buffer
}
```

### cURL

```bash
# Basic usage
curl -X POST http://localhost:4123/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Your text here"}' \
  --output output.wav

# With custom parameters
curl -X POST http://localhost:4123/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Dramatic text!", "exaggeration": 1.0, "cfg_weight": 0.3}' \
  --output dramatic.wav

# Test the interactive documentation
curl http://localhost:4123/docs
```

## Development Features

### FastAPI Development Tools

- **Auto-reload**: Use `--reload` flag for development
- **Interactive testing**: Use `/docs` for live API testing
- **Type hints**: Full IDE support with Pydantic models
- **Validation**: Automatic request/response validation
- **OpenAPI**: Machine-readable API specification

### Development Mode

```bash
# Start with auto-reload
uvicorn app.main:app --host 0.0.0.0 --port 4123 --reload

# Or with verbose logging
uvicorn app.main:app --host 0.0.0.0 --port 4123 --log-level debug
```

## Troubleshooting

### Common Issues

1. **Model not loading**: Ensure Chatterbox TTS is properly installed
2. **Voice sample missing**: Verify `voice-sample.mp3` exists at the configured path
3. **CUDA out of memory**: Try using CPU device (`DEVICE=cpu`)
4. **Slow performance**: GPU recommended; ensure CUDA/MPS is available
5. **Port conflicts**: Change `PORT` environment variable to an available port
6. **Uvicorn not found**: Install with `pip install uvicorn[standard]`

### FastAPI Specific Issues

**Startup Issues:**

```bash
# Check if uvicorn is installed
uvicorn --version

# Run with verbose logging
uvicorn app.main:app --host 0.0.0.0 --port 4123 --log-level debug

# Alternative startup method
python main.py
```

**Validation Errors:**

Visit `/docs` to see the interactive API documentation and test your requests.

### Checking Configuration

```bash
# Check if API is running
curl http://localhost:4123/health

# View current configuration
curl http://localhost:4123/config

# Check API documentation
curl http://localhost:4123/openapi.json

# Test with simple text
curl -X POST http://localhost:4123/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Test"}' \
  --output test.wav
```

## Migration from Flask

If you're migrating from the previous Flask version:

1. **Dependencies**: Update to `fastapi` and `uvicorn` instead of `flask`
2. **Startup**: Use `uvicorn app.main:app` instead of `python api.py`
3. **Documentation**: Visit `/docs` for interactive API testing
4. **Validation**: Error responses now use HTTP 422 for validation errors
5. **Performance**: Expect 25-40% better performance for JSON responses

All existing API endpoints and request/response formats remain compatible.
