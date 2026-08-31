# Voice Library Management

## 🎵 Overview

The Chatterbox TTS API now includes a comprehensive voice library management system that allows users to upload, manage, and use custom voices across all speech generation endpoints. This feature enables you to create a persistent collection of voices that can be referenced by name in API calls.

## ✨ Key Features

- **Persistent Voice Storage**: Uploaded voices are stored persistently and survive container restarts
- **Voice Selection by Name**: Reference uploaded voices by name in any speech generation endpoint
- **Multiple Audio Formats**: Support for MP3, WAV, FLAC, M4A, and OGG files
- **RESTful Voice Management**: Full CRUD operations for voice management
- **Docker & Local Support**: Works seamlessly with both Docker and direct Python installations
- **Frontend Integration**: Complete voice management UI in the web frontend

## 🚀 Getting Started

### For Docker Users

The voice library is automatically configured when using Docker. Voices are stored in a persistent volume:

```bash
# Start with voice library enabled
docker-compose up -d

# Your voices will be persisted in the "chatterbox-voices" Docker volume
```

### For Local Python Users

Create a voice library directory (default: `./voices`):

```bash
# Create voices directory
mkdir voices

# Or set custom location
export VOICE_LIBRARY_DIR="/path/to/your/voices"
```

## 📚 API Endpoints

### List Voices

**GET** `/v1/voices`

Get a list of all voices in the library.

```bash
curl -X GET "http://localhost:4123/v1/voices"
```

**Response:**

```json
{
  "voices": [
    {
      "name": "sarah_professional",
      "filename": "sarah_professional.mp3",
      "original_filename": "sarah_recording.mp3",
      "file_extension": ".mp3",
      "file_size": 1024768,
      "upload_date": "2024-01-15T10:30:00Z",
      "path": "/voices/sarah_professional.mp3"
    }
  ],
  "count": 1
}
```

### Upload Voice

**POST** `/v1/voices`

Upload a new voice to the library.

```bash
curl -X POST "http://localhost:4123/v1/voices" \
  -F "voice_name=sarah_professional" \
  -F "voice_file=@/path/to/voice.mp3"
```

**Parameters:**

- `voice_name` (string): Name for the voice (used in API calls)
- `voice_file` (file): Audio file (MP3, WAV, FLAC, M4A, OGG, max 10MB)

### Delete Voice

**DELETE** `/v1/voices/{voice_name}`

Delete a voice from the library.

```bash
curl -X DELETE "http://localhost:4123/v1/voices/sarah_professional"
```

### Rename Voice

**PUT** `/v1/voices/{voice_name}`

Rename an existing voice.

```bash
curl -X PUT "http://localhost:4123/v1/voices/sarah_professional" \
  -F "new_name=sarah_business"
```

### Get Voice Info

**GET** `/v1/voices/{voice_name}`

Get detailed information about a specific voice.

```bash
curl -X GET "http://localhost:4123/v1/voices/sarah_professional"
```

### Download Voice

**GET** `/v1/voices/{voice_name}/download`

Download the original voice file.

```bash
curl -X GET "http://localhost:4123/v1/voices/sarah_professional/download" \
  --output voice.mp3
```

## 🎤 Using Voices in Speech Generation

### JSON API (Recommended)

Use the voice name in the `voice` parameter:

```bash
curl -X POST "http://localhost:4123/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Hello! This is using my custom voice.",
    "voice": "sarah_professional",
    "exaggeration": 0.7,
    "temperature": 0.8
  }' \
  --output speech.wav
```

### Form Data API

```bash
curl -X POST "http://localhost:4123/v1/audio/speech/upload" \
  -F "input=Hello! This is using my custom voice." \
  -F "voice=sarah_professional" \
  -F "exaggeration=0.7" \
  --output speech.wav
```

### Streaming API

```bash
curl -X POST "http://localhost:4123/v1/audio/speech/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "This will stream with my custom voice.",
    "voice": "sarah_professional"
  }' \
  --output stream.wav
```

## 🔧 Configuration

### Environment Variables

```bash
# Voice library directory (default: ./voices for local, /voices for Docker)
VOICE_LIBRARY_DIR=/path/to/voices

# For Docker, this is typically set to /voices and mounted as a volume
```

### Docker Configuration

The voice library is automatically configured in Docker with a persistent volume:

```yaml
volumes:
  - chatterbox-voices:/voices
```

## 📝 Voice Naming Guidelines

### Valid Characters

- Letters (a-z, A-Z)
- Numbers (0-9)
- Underscores (\_)
- Hyphens (-)
- Spaces (converted to underscores)

### Invalid Characters

- Forward/backward slashes (/, \\)
- Colons (:)
- Asterisks (\*)
- Question marks (?)
- Quotes (", ')
- Angle brackets (<, >)
- Pipes (|)

### Examples

```bash
✅ Good names:
- "sarah_professional"
- "john-voice-2024"
- "female_american"
- "narration_style"

❌ Invalid names:
- "sarah/professional"  # Contains slash
- "voice:sample"        # Contains colon
- "my voice?"           # Contains question mark
```

## 🎯 Best Practices

### Voice Quality

- Use high-quality audio samples (16-48kHz sample rate)
- Aim for 10-30 seconds of clean speech
- Avoid background noise and music
- Choose samples with consistent volume

### File Management

- Use descriptive voice names
- Keep file sizes reasonable (< 10MB)
- Organize voices by speaker or style
- Clean up unused voices periodically

### API Usage

- Use the JSON API for better performance
- Cache voice lists on the client side
- Handle voice-not-found errors gracefully
- Test voices before production use

## 🔍 Troubleshooting

### Voice Not Found

```json
{
  "error": {
    "message": "Voice 'my_voice' not found in voice library. Use /voices endpoint to list available voices.",
    "type": "voice_not_found_error"
  }
}
```

**Solution:** Check available voices with `GET /v1/voices` or upload the voice first.

### Upload Failed

```json
{
  "error": {
    "message": "Unsupported audio format: .txt. Supported formats: .mp3, .wav, .flac, .m4a, .ogg",
    "type": "invalid_request_error"
  }
}
```

**Solution:** Use a supported audio format and ensure the file is valid.

### Voice Already Exists

```json
{
  "error": {
    "message": "Voice 'sarah_professional' already exists",
    "type": "voice_exists_error"
  }
}
```

**Solution:** Use a different name or delete the existing voice first.

## 🎛️ Frontend Integration

The web frontend includes a complete voice library management interface:

- **Voice Library Panel**: Browse and manage voices
- **Upload Modal**: Easy voice upload with drag-and-drop
- **Voice Selection**: Choose voices in the TTS interface
- **Preview Playback**: Listen to voice samples before use
- **Rename/Delete**: Manage voice metadata

## 📊 Migration from Client-Side Storage

If you were previously using the client-side voice library (localStorage), you'll need to re-upload your voices to the new server-side library for persistence and cross-device access.

## 🔗 API Aliases

All voice endpoints support multiple URL formats:

- `/v1/voices` (recommended)
- `/voices`
- `/voice-library`
- `/voice_library`

## 🏷️ OpenAI Compatibility

The voice parameter also accepts OpenAI voice names for compatibility:

- `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`

These will use the default configured voice sample, while custom names will use uploaded voices from the library.

## 🛡️ Security Considerations

- Voice files are stored on the server filesystem
- File uploads are validated for type and size
- Voice names are sanitized to prevent path traversal
- No authentication required (same as other endpoints)

## 📈 Performance Notes

- Voice library operations are fast (< 100ms typical)
- Voice files are loaded on-demand for TTS generation
- Large voice files may increase TTS processing time
- Consider voice file size vs. quality trade-offs

## 🆙 Future Enhancements

Planned features for future releases:

- Voice categorization and tagging
- Bulk voice operations
- Voice sharing between users
- Advanced voice metadata
- Voice quality analysis
- Automatic voice optimization
