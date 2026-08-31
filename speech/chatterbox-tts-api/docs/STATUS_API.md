# TTS Status API Documentation

This document describes the new status tracking endpoints that provide real-time information about TTS processing.

## Overview

The status API allows you to monitor TTS request processing in real-time, view progress information, check statistics, and review request history.

## Endpoints

### 🔍 GET `/status`

Get comprehensive TTS processing status information.

**Query Parameters:**

- `include_memory` (boolean): Include memory usage information
- `include_history` (boolean): Include recent request history
- `include_stats` (boolean): Include processing statistics
- `history_limit` (integer): Number of history records to return (1-20)

**Example:**

```bash
curl "http://localhost:4123/status?include_memory=true&include_stats=true"
```

**Response:**

```json
{
  "status": "generating_audio",
  "is_processing": true,
  "request_id": "abc12345",
  "start_time": 1704067200.0,
  "duration_seconds": 2.5,
  "text_length": 156,
  "text_preview": "This is the text being processed...",
  "voice_source": "default",
  "parameters": {
    "exaggeration": 0.7,
    "cfg_weight": 0.5,
    "temperature": 0.8
  },
  "progress": {
    "current_chunk": 2,
    "total_chunks": 4,
    "current_step": "Generating audio for chunk 2/4",
    "progress_percentage": 50.0,
    "estimated_completion": 1704067205.0
  },
  "total_requests": 42
}
```

### ⚡ GET `/status/progress`

Get lightweight progress information (optimized for polling).

**Example:**

```bash
curl "http://localhost:4123/status/progress"
```

**Response when processing:**

```json
{
  "is_processing": true,
  "status": "generating_audio",
  "current_step": "Generating audio for chunk 2/4",
  "current_chunk": 2,
  "total_chunks": 4,
  "progress_percentage": 50.0,
  "duration_seconds": 2.5,
  "estimated_completion": 1704067205.0,
  "text_preview": "This is the text being processed..."
}
```

**Response when idle:**

```json
{
  "is_processing": false,
  "status": "idle",
  "message": "No active TTS requests"
}
```

### 📊 GET `/status/statistics`

Get comprehensive processing statistics.

**Query Parameters:**

- `include_memory` (boolean): Include current memory usage

**Example:**

```bash
curl "http://localhost:4123/status/statistics?include_memory=true"
```

**Response:**

```json
{
  "total_requests": 42,
  "completed_requests": 38,
  "error_requests": 4,
  "success_rate": 90.5,
  "average_duration_seconds": 3.2,
  "average_text_length": 124.5,
  "is_processing": false,
  "current_memory": {
    "cpu_memory_mb": 256.7,
    "gpu_memory_allocated_mb": 1024.3
  }
}
```

### 📝 GET `/status/history`

Get recent TTS request history.

**Query Parameters:**

- `limit` (integer): Number of records to return (1-50, default: 10)

**Example:**

```bash
curl "http://localhost:4123/status/history?limit=5"
```

**Response:**

```json
{
  "request_history": [
    {
      "request_id": "abc12345",
      "status": "completed",
      "start_time": 1704067200.0,
      "end_time": 1704067203.5,
      "duration_seconds": 3.5,
      "text_length": 156,
      "text_preview": "Hello world, this is a test...",
      "voice_source": "default",
      "parameters": {
        "exaggeration": 0.7,
        "cfg_weight": 0.5,
        "temperature": 0.8
      }
    }
  ],
  "total_records": 5,
  "limit": 5
}
```

### 🗑️ POST `/status/history/clear`

Clear TTS request history.

**Query Parameters:**

- `confirm` (boolean): Required confirmation flag

**Example:**

```bash
curl -X POST "http://localhost:4123/status/history/clear?confirm=true"
```

### 📋 GET `/info`

Get comprehensive API information including status, memory, and statistics.

**Example:**

```bash
curl "http://localhost:4123/info"
```

**Response:**

```json
{
  "api_name": "Chatterbox TTS API",
  "version": "1.0.0",
  "status": "operational",
  "tts_status": {
    /* current status */
  },
  "statistics": {
    /* processing stats */
  },
  "memory_info": {
    /* memory usage */
  },
  "recent_requests": [
    /* last 3 requests */
  ],
  "uptime_info": {
    "total_requests": 42,
    "success_rate": 90.5,
    "is_processing": false
  }
}
```

## Status Values

The `status` field can have these values:

- `idle`: No active requests
- `initializing`: Starting request processing
- `processing_text`: Validating and preparing text
- `chunking`: Splitting text into chunks
- `generating_audio`: Generating audio for chunks
- `concatenating`: Combining audio chunks
- `finalizing`: Converting to output format
- `completed`: Request completed successfully
- `error`: Request failed with error

## Endpoint Aliases

All endpoints support multiple path formats for compatibility:

| Primary Path         | Aliases                                           |
| -------------------- | ------------------------------------------------- |
| `/status`            | `/v1/status`, `/processing`, `/processing/status` |
| `/status/progress`   | `/v1/status/progress`, `/progress`                |
| `/status/history`    | `/v1/status/history`, `/history`                  |
| `/status/statistics` | `/v1/status/statistics`, `/stats`                 |
| `/info`              | `/v1/info`, `/api/info`                           |

## Frontend Integration

### Real-time Progress Monitoring

```typescript
import { createTTSService } from './services/tts';

const ttsService = createTTSService('http://localhost:4123');

// Monitor progress during generation
const monitorProgress = async () => {
  const interval = setInterval(async () => {
    try {
      const progress = await ttsService.getProgress();
      if (progress.is_processing) {
        console.log(`Progress: ${progress.progress_percentage}%`);
        console.log(`Step: ${progress.current_step}`);
      } else {
        clearInterval(interval);
        console.log('Processing complete');
      }
    } catch (error) {
      console.error('Failed to get progress:', error);
    }
  }, 1000);
};
```

### React Hook Example

```typescript
import { useQuery } from '@tanstack/react-query';

const useProcessingStatus = () => {
  return useQuery({
    queryKey: ['tts-status'],
    queryFn: () => ttsService.getProgress(),
    refetchInterval: 1000, // Poll every second
    enabled: true,
  });
};

// Usage in component
const { data: status } = useProcessingStatus();
if (status?.is_processing) {
  // Show progress UI
}
```

## Testing

Run the status endpoint tests:

```bash
python tests/test_status.py
```

This will test:

- ✅ All status endpoints
- 🎤 Status tracking during TTS generation
- 🔄 Concurrent request handling
- 📊 Real-time progress monitoring

## Notes

- Status information is thread-safe for concurrent requests
- Progress percentages are calculated based on chunk processing
- Memory information requires memory monitoring to be enabled
- History is limited to the last 10 requests by default
- Estimated completion times are calculated based on current progress

## Error Handling

All endpoints return appropriate HTTP status codes:

- `200`: Success
- `400`: Bad request (invalid parameters)
- `500`: Internal server error

Error responses follow this format:

```json
{
  "error": {
    "message": "Error description",
    "type": "error_type"
  }
}
```
