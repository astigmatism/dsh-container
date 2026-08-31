# Streaming TTS API Documentation

## 🎵 Overview

The Chatterbox TTS API supports real-time audio streaming, allowing clients to receive audio data as it's generated rather than waiting for complete processing. This significantly reduces perceived latency and improves user experience, especially for longer texts.

## ✨ Key Benefits

- **Lower Latency**: Start receiving audio before full generation is complete
- **Better User Experience**: Perceived faster response times for long texts
- **Resource Efficiency**: Lower memory usage as chunks are processed individually
- **Real-time Processing**: Audio generation happens progressively
- **Interruption Support**: Can potentially stop generation mid-stream if needed
- **Memory Optimization**: Automatic cleanup of processed chunks

## 🚀 Streaming Endpoints

### Basic Streaming

**POST** `/audio/speech/stream`

Generate and stream speech audio in real-time using the configured voice sample.

**Request Body (JSON):**

```json
{
  "input": "Text to convert to speech",
  "exaggeration": 0.7,
  "cfg_weight": 0.4,
  "temperature": 0.9,
  "streaming_chunk_size": 200,
  "streaming_strategy": "sentence"
}
```

### Server-Side Events (SSE) Streaming

**POST** `/audio/speech`

Generate speech using Server-Side Events format (OpenAI compatible) by setting `stream_format` to `"sse"`.

**Request Body (JSON):**

```json
{
  "input": "Text to convert to speech",
  "stream_format": "sse",
  "exaggeration": 0.7,
  "cfg_weight": 0.4,
  "temperature": 0.9,
  "streaming_chunk_size": 200,
  "streaming_strategy": "sentence"
}
```

**Response Format:**
Returns `text/event-stream` with JSON events:

```
data: {"type": "speech.audio.delta", "audio": "base64_encoded_audio_chunk"}

data: {"type": "speech.audio.delta", "audio": "base64_encoded_audio_chunk"}

data: {"type": "speech.audio.done", "usage": {"input_tokens": 10, "output_tokens": 150, "total_tokens": 160}}
```

### Streaming with Voice Upload

**POST** `/audio/speech/stream/upload`

Generate and stream speech audio with optional custom voice file upload.

**Request (Multipart Form):**

- `input` (string): Text to convert to speech
- `voice_file` (file, optional): Custom voice sample file
- `exaggeration` (float, optional): Emotion intensity (0.25-2.0)
- `cfg_weight` (float, optional): Pace control (0.0-1.0)
- `temperature` (float, optional): Sampling randomness (0.05-5.0)
- `streaming_chunk_size` (int, optional): Characters per streaming chunk
- `streaming_strategy` (string, optional): Chunking strategy

## 🎛️ Streaming Parameters

### Core TTS Parameters

| Parameter      | Type  | Range    | Default | Description         |
| -------------- | ----- | -------- | ------- | ------------------- |
| `exaggeration` | float | 0.25-2.0 | 0.5     | Emotion intensity   |
| `cfg_weight`   | float | 0.0-1.0  | 0.5     | Pace control        |
| `temperature`  | float | 0.05-5.0 | 0.8     | Sampling randomness |

### Streaming-Specific Parameters

| Parameter               | Type   | Options                          | Default    | Description                        |
| ----------------------- | ------ | -------------------------------- | ---------- | ---------------------------------- |
| `streaming_chunk_size`  | int    | 50-500                           | 200        | Characters per streaming chunk     |
| `streaming_strategy`    | string | sentence, paragraph, fixed, word | "sentence" | How to break up text for streaming |
| `streaming_buffer_size` | int    | 1-10                             | 3          | Number of chunks to buffer         |
| `streaming_quality`     | string | fast, balanced, high             | "balanced" | Speed vs quality trade-off         |

## 📝 Streaming Strategies

### Sentence Strategy (Default)

```json
{
  "streaming_strategy": "sentence",
  "streaming_chunk_size": 200
}
```

- Splits at sentence boundaries (`.`, `!`, `?`)
- Respects sentence integrity
- Good balance of latency and naturalness
- **Best for**: General use, reading content

### Paragraph Strategy

```json
{
  "streaming_strategy": "paragraph",
  "streaming_chunk_size": 400
}
```

- Splits at paragraph breaks (`\n\n`, double line breaks)
- Maintains paragraph context
- Longer chunks, more natural flow
- **Best for**: Articles, stories, structured content

### Fixed Strategy

```json
{
  "streaming_strategy": "fixed",
  "streaming_chunk_size": 150
}
```

- Fixed character count chunks
- Predictable timing
- May break mid-sentence
- **Best for**: Consistent streaming timing, testing

### Word Strategy

```json
{
  "streaming_strategy": "word",
  "streaming_chunk_size": 100
}
```

- Splits at word boundaries
- Very fine-grained streaming
- Maximum responsiveness
- **Best for**: Real-time chat, interactive applications

## 🎯 Quality vs Speed Settings

### Fast Mode

```json
{
  "streaming_quality": "fast",
  "streaming_chunk_size": 100,
  "streaming_strategy": "word"
}
```

- Smaller chunks for faster initial response
- Lower quality synthesis parameters
- **Use case**: Chat applications, real-time feedback

### Balanced Mode (Default)

```json
{
  "streaming_quality": "balanced",
  "streaming_chunk_size": 200,
  "streaming_strategy": "sentence"
}
```

- Good balance of speed and quality
- Sentence-aware chunking
- **Use case**: General applications

### High Quality Mode

```json
{
  "streaming_quality": "high",
  "streaming_chunk_size": 300,
  "streaming_strategy": "paragraph"
}
```

- Larger chunks for better context
- Higher quality synthesis
- **Use case**: Audiobooks, professional content

## 💻 Usage Examples

### Basic cURL Examples

**Simple Streaming:**

```bash
curl -X POST http://localhost:4123/v1/audio/speech/stream \
  -H "Content-Type: application/json" \
  -d '{"input": "This will stream as it generates!"}' \
  --output streaming.wav
```

**SSE Streaming (OpenAI Compatible):**

```bash
curl -X POST http://localhost:4123/v1/audio/speech \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"input": "This streams as Server-Side Events!", "stream_format": "sse"}' \
  --no-buffer
```

**Advanced Streaming with Custom Settings:**

```bash
curl -X POST http://localhost:4123/v1/audio/speech/stream \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Long text that will be streamed efficiently...",
    "exaggeration": 0.8,
    "streaming_strategy": "sentence",
    "streaming_chunk_size": 150,
    "streaming_quality": "balanced"
  }' \
  --output advanced_stream.wav
```

**Real-time Playback:**

```bash
curl -X POST http://localhost:4123/v1/audio/speech/stream \
  -H "Content-Type: application/json" \
  -d '{"input": "Play this as it streams!", "streaming_quality": "fast"}' \
  | ffplay -f wav -i pipe:0 -autoexit -nodisp
```

### Python Examples

#### Basic Streaming

```python
import requests

response = requests.post(
    "http://localhost:4123/v1/audio/speech/stream",
    json={
        "input": "This streams as it's generated!",
        "streaming_strategy": "sentence",
        "streaming_chunk_size": 200
    },
    stream=True
)

# The response is a single, continuous WAV stream.
# You can write it directly to a file.
with open("streaming_output.wav", "wb") as f:
    for chunk in response.iter_content(chunk_size=8192):
        if chunk:
            f.write(chunk)
            print(f"Received chunk: {len(chunk)} bytes")
```

#### SSE Streaming (OpenAI Compatible)

```python
import requests
import json
import base64
import wave
import io

def create_wav_from_pcm(pcm_data, sample_rate, channels, bits_per_sample):
    """Creates a WAV file in memory from raw PCM data."""
    wav_file = io.BytesIO()
    with wave.open(wav_file, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(bits_per_sample // 8)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    wav_file.seek(0)
    return wav_file.getvalue()

response = requests.post(
    "http://localhost:4123/v1/audio/speech",
    json={
        "input": "This streams as Server-Side Events with raw audio!",
        "stream_format": "sse"
    },
    stream=True,
    headers={'Accept': 'text/event-stream'}
)

audio_chunks = []
audio_info = {}

for line in response.iter_lines(decode_unicode=True):
    if line.startswith('data: '):
        event_data = line[6:]

        try:
            event = json.loads(event_data)

            # First event contains audio metadata
            if event.get('type') == 'speech.audio.info':
                audio_info = {
                    "sample_rate": event['sample_rate'],
                    "channels": event['channels'],
                    "bits_per_sample": event['bits_per_sample']
                }
                print(f"Received audio info: {audio_info}")

            # Subsequent events contain raw audio data
            elif event.get('type') == 'speech.audio.delta':
                audio_data = base64.b64decode(event['audio'])
                audio_chunks.append(audio_data)
                print(f"Received audio chunk: {len(audio_data)} bytes")

            # Final event indicates completion
            elif event.get('type') == 'speech.audio.done':
                usage = event.get('usage', {})
                print(f"Streaming complete. Usage: {usage}")
                break

        except json.JSONDecodeError:
            continue

# Combine raw PCM data and create a valid WAV file
if audio_chunks and audio_info:
    combined_pcm_data = b"".join(audio_chunks)

    wav_data = create_wav_from_pcm(
        combined_pcm_data,
        sample_rate=audio_info['sample_rate'],
        channels=audio_info['channels'],
        bits_per_sample=audio_info['bits_per_sample']
    )

    with open("sse_output.wav", "wb") as f:
        f.write(wav_data)
    print(f"Saved {len(audio_chunks)} audio chunks to sse_output.wav")
else:
    print("No audio data was received.")
```

#### Real-time Playback with sounddevice

```python
import requests
import sounddevice as sd
import wave
import io

def stream_and_play_realtime(text, **params):
    """Stream TTS and play audio in real-time using sounddevice"""

    print("Requesting audio stream...")
    # Start streaming request
    response = requests.post(
        "http://localhost:4123/v1/audio/speech/stream",
        json={"input": text, **params},
        stream=True
    )

    if response.status_code != 200:
        print(f"Error from server: {response.status_code}")
        print(response.text)
        return

    # The first part of the stream is the WAV header.
    # We can read it to determine the audio format.
    try:
        header = response.raw.read(44)
    except Exception as e:
        print(f"Failed to read header from stream: {e}")
        return

    # Use the header to get audio properties
    try:
        with wave.open(io.BytesIO(header)) as wf:
            channels = wf.getnchannels()
            samplerate = wf.getframerate()
            sampwidth = wf.getsampwidth()

            # Map sample width to numpy dtype
            if sampwidth == 2:
                dtype = 'int16'
            elif sampwidth == 1:
                dtype = 'int8'
            elif sampwidth == 3: # 24-bit
                dtype = 'int24'
            elif sampwidth == 4:
                dtype = 'int32'
            else:
                raise ValueError(f"Unsupported sample width: {sampwidth}")

            print(f"Audio stream info: {samplerate}Hz, {channels}ch, {dtype}")
    except Exception as e:
        print(f"Failed to parse WAV header: {e}")
        return

    # Create and start the output stream
    try:
        with sd.RawOutputStream(
            samplerate=samplerate,
            channels=channels,
            dtype=dtype
        ) as stream:
            print("Playback started... press Ctrl+C to stop.")
            # Read the rest of the stream (raw PCM data) and play it
            while True:
                chunk = response.raw.read(1024)
                if not chunk:
                    break
                stream.write(chunk)
            print("Playback finished.")
    except Exception as e:
        print(f"An error occurred during playback: {e}")
    except KeyboardInterrupt:
        print("\nPlayback stopped by user.")


# Usage
# Note: You may need to install sounddevice: pip install sounddevice
stream_and_play_realtime(
    "This plays in real-time as it streams using the sounddevice library!",
    streaming_quality="fast"
)
```

### JavaScript/TypeScript Examples

#### Basic Streaming

```typescript
async function streamTTS(text: string, options: any = {}) {
  const response = await fetch('/v1/audio/speech/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: text,
      streaming_strategy: 'sentence',
      streaming_chunk_size: 200,
      ...options,
    }),
  });

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;

    chunks.push(value);
    console.log(`Received chunk: ${value.length} bytes`);
  }

  // Combine chunks into final audio
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const audioData = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    audioData.set(chunk, offset);
    offset += chunk.length;
  }

  return audioData;
}
```

#### Real-time Audio Playback

```typescript
async function streamAndPlayTTS(text: string) {
  const audio = new Audio();
  const mediaSource = new MediaSource();
  audio.src = URL.createObjectURL(mediaSource);
  audio.play().catch((e) => console.error('Autoplay was prevented:', e));

  mediaSource.addEventListener(
    'sourceopen',
    async () => {
      // The MIME type for WAV audio is 'audio/wav'. For MSE, specifying codecs
      // can be helpful, e.g., 'audio/wav; codecs=1' for PCM.
      const sourceBuffer = mediaSource.addSourceBuffer('audio/wav');

      try {
        const response = await fetch('/v1/audio/speech/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: text,
            streaming_quality: 'fast',
          }),
        });

        const reader = response.body!.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Ensure all buffered data is processed before ending the stream
            if (!sourceBuffer.updating && mediaSource.readyState === 'open') {
              mediaSource.endOfStream();
            }
            break;
          }

          // Wait for previous append to finish
          if (sourceBuffer.updating) {
            await new Promise((resolve) =>
              sourceBuffer.addEventListener('updateend', resolve, {
                once: true,
              })
            );
          }
          sourceBuffer.appendBuffer(value);
        }
      } catch (e) {
        console.error('Streaming failed:', e);
        if (mediaSource.readyState === 'open' && !sourceBuffer.updating) {
          mediaSource.endOfStream();
        }
      }
    },
    { once: true }
  );
}
```

## 📊 Performance Optimization

### Choosing Optimal Settings

**For Lowest Latency:**

```json
{
  "streaming_quality": "fast",
  "streaming_strategy": "word",
  "streaming_chunk_size": 80,
  "streaming_buffer_size": 1
}
```

**For Best Quality:**

```json
{
  "streaming_quality": "high",
  "streaming_strategy": "paragraph",
  "streaming_chunk_size": 350,
  "streaming_buffer_size": 5
}
```

**For Balanced Performance:**

```json
{
  "streaming_quality": "balanced",
  "streaming_strategy": "sentence",
  "streaming_chunk_size": 200,
  "streaming_buffer_size": 3
}
```

### Memory Optimization

The streaming implementation includes automatic memory management:

- Chunks are processed and freed immediately
- GPU memory is cleared periodically
- Temporary files are cleaned up automatically
- Progress tracking prevents memory leaks

## 🔄 Progress Monitoring

### Real-time Progress API

While streaming is active, you can monitor progress:

```bash
curl "http://localhost:4123/v1/status/progress"
```

**Response:**

```json
{
  "is_processing": true,
  "status": "generating_audio",
  "current_step": "Streaming audio for chunk 3/8",
  "current_chunk": 3,
  "total_chunks": 8,
  "progress_percentage": 37.5,
  "duration_seconds": 2.1,
  "estimated_completion": 1704067205.0,
  "text_preview": "This is the text being streamed..."
}
```

### Integration with Frontend

```typescript
// Monitor streaming progress
const monitorStreaming = async () => {
  const interval = setInterval(async () => {
    try {
      const response = await fetch('/v1/status/progress');
      const progress = await response.json();

      if (progress.is_processing) {
        updateProgressBar(progress.progress_percentage);
        updateStatus(progress.current_step);
      } else {
        clearInterval(interval);
        onStreamingComplete();
      }
    } catch (error) {
      console.error('Progress monitoring failed:', error);
    }
  }, 500);
};
```

## 🛠️ Troubleshooting

### Common Issues

**Streaming Stops Unexpectedly:**

- Check network stability
- Verify streaming headers are set correctly
- Ensure client supports chunked transfer encoding

**Audio Quality Issues:**

- Try larger `streaming_chunk_size`
- Use "sentence" or "paragraph" strategy
- Increase `streaming_quality` to "balanced" or "high"

**High Latency:**

- Reduce `streaming_chunk_size`
- Use "word" strategy for maximum responsiveness
- Set `streaming_quality` to "fast"

**Memory Issues:**

- Reduce `streaming_buffer_size`
- Use smaller `streaming_chunk_size`
- Monitor memory usage via `/memory` endpoint

### Debugging Commands

```bash
# Test streaming endpoint
curl -v -X POST http://localhost:4123/v1/audio/speech/stream \
  -H "Content-Type: application/json" \
  -d '{"input": "Test streaming"}' \
  --output debug_stream.wav

# Monitor memory during streaming
watch -n 1 'curl -s http://localhost:4123/memory | jq .memory_info'

# Check streaming progress
watch -n 0.5 'curl -s http://localhost:4123/v1/status/progress | jq .'
```

## 🔄 Comparison: Streaming vs Standard

### When to Use Streaming

**Use Streaming When:**

- Text length > 500 characters
- Building real-time applications
- Memory usage is a concern
- Users expect immediate audio feedback
- Implementing chat or interactive features

**Use Standard When:**

- Text length < 200 characters
- Need complete audio file before processing
- Working with simple integrations
- Bandwidth is limited
- Processing batch content

### Performance Comparison

| Aspect              | Standard Generation   | Streaming Generation  |
| ------------------- | --------------------- | --------------------- |
| **Initial Latency** | Full generation time  | ~1-2 seconds          |
| **Memory Usage**    | Peak during concat    | Constant low usage    |
| **User Experience** | Wait then play        | Progressive playback  |
| **Network Usage**   | Single large transfer | Multiple small chunks |
| **Complexity**      | Simple                | Moderate              |

## 🚀 Future Enhancements

Planned improvements to the streaming functionality:

- **Adaptive Chunking**: Automatically adjust chunk size based on content
- **Quality Adaptation**: Dynamic quality adjustment based on network conditions
- **Interruption Support**: Ability to stop streaming mid-generation
- **Buffer Prediction**: Intelligent buffering based on generation speed
- **Multi-voice Streaming**: Stream different voices for different speakers
- **WebSocket Support**: Real-time bidirectional streaming

## 📖 API Reference

For complete API documentation including all endpoints, parameters, and examples, visit:

- **Interactive Documentation**: http://localhost:4123/docs
- **Alternative Documentation**: http://localhost:4123/redoc
- **OpenAPI Schema**: http://localhost:4123/openapi.json

The streaming endpoints are fully documented with request/response schemas, parameter validation, and example payloads.
