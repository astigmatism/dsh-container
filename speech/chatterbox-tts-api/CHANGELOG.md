# Changelog

All notable changes to the Chatterbox TTS API project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2025-09-15

### Feature: Long Text Synthesis

This release introduces the capability to synthesize long-form text by splitting it into manageable chunks, processing them in the background, and concatenating the final audio.

The frontend now allows for long text inputs and has been revamped completely to be able to handle the status of the processing, to keep a history of previous long-text speech generations (and their configurations), etc.

### Added

#### Long Text Job Processing

- **Asynchronous Job Handling**: Implemented a background processing system to handle long text synthesis jobs without blocking the API.
- **New API Endpoints**: Introduced a new set of endpoints for creating long text jobs, querying their status, and performing bulk actions.
- **Audio Concatenation**: Integrated `pydub` to seamlessly concatenate generated audio chunks into a single, coherent audio file.

#### Frontend Integration

- **Job Management UI**: Added a new section in the frontend to submit text for long synthesis, monitor job progress, and download the final audio.
- **Real-time Status Updates**: The UI now displays the real-time status and progress of ongoing long text jobs.

#### Configuration & Dependencies

- **New Configuration**: Added environment variables to `.env.example` and `.env.example.docker` for configuring long text TTS behavior.
- **New Dependencies**: Added `pydub` for audio manipulation and `sse-starlette` to support job processing.

### Enhanced

#### Input Handling

- **Validation and Error Handling**: Improved validation for long text inputs to ensure job stability and provide clearer error feedback to the user.

---

## [2.0.0] — 2025-09-10

### Major Release: Multilingual Support

This major version introduces comprehensive multilingual text-to-speech capabilities, supporting 22 languages with enhanced voice cloning and automatic language detection. This release represents a significant architectural upgrade to the TTS engine.

### 🌍 Added

#### Multilingual TTS Engine

- **22 Language Support**: Complete multilingual text-to-speech generation using the enhanced `chatterbox-tts` v0.1.4 multilingual model
- **Supported Languages**: Arabic, Danish, German, Greek, English, Spanish, Finnish, French, Hebrew, Hindi, Italian, Japanese, Korean, Malay, Dutch, Norwegian, Polish, Portuguese, Russian, Swedish, Swahili, Turkish
- **Language-Aware Voice Cloning**: Upload and manage voice samples with specific language assignments
- **Automatic Language Detection**: Speech generation automatically uses the voice's assigned language without requiring language parameters in requests

#### New API Endpoints

- **`GET /languages`**: Retrieve list of all supported languages with codes and names
- **Enhanced Voice Upload**: Voice upload endpoint now accepts optional `language` parameter with validation against supported languages
- **Language Metadata**: Voice library responses now include language information in metadata

#### Configuration Management

- **`USE_MULTILINGUAL_MODEL`**: New environment variable to enable/disable multilingual support (default: `true`)
- **Automatic Model Selection**: System automatically selects multilingual or standard model based on configuration
- **Graceful Fallbacks**: Falls back to English for unsupported languages or when multilingual mode is disabled

#### Frontend Multilingual Integration

- **Language Selection UI**: Complete language picker with native names and flag emojis
- **Voice Library Language Display**: Language badges and indicators for each voice in the library
- **Upload Modal Enhancement**: Integrated language selector in voice upload interface with real-time validation
- **Visual Language Indicators**: Flag emojis and language codes throughout the user interface

#### Developer Experience

- **Comprehensive Documentation**: New `docs/MULTILINGUAL.md` with complete API reference and usage examples
- **Testing Guide**: `docs/MULTILINGUAL_TESTING_GUIDE.md` with step-by-step testing instructions
- **Language Constants**: Frontend language utilities and constants for consistent UI display
- **API Examples**: Multilingual usage examples in Python, JavaScript, and cURL

### 🔄 Enhanced

#### Backend Architecture

- **Speech Generation Pipeline**: Updated all speech endpoints to use `resolve_voice_path_and_language()` for automatic language detection
- **Streaming Support**: All streaming endpoints now support multilingual voices with language-aware processing
- **Voice Library System**: Enhanced voice metadata storage to include language information with backward compatibility
- **Memory Management**: Optimized memory handling for multilingual model operations

#### API Improvements

- **Request Validation**: Enhanced voice upload validation with language code verification
- **Response Models**: Updated voice library responses to include language metadata
- **Error Handling**: Improved error messages for language validation and unsupported language scenarios
- **OpenAI Compatibility**: Maintained full OpenAI API compatibility while adding multilingual capabilities

#### Frontend Enhancements

- **Language Utilities**: New frontend utilities for language display, validation, and flag emoji mapping
- **State Management**: Enhanced voice library state management to handle language metadata
- **User Experience**: Improved upload workflow with language selection and validation feedback
- **Responsive Design**: Language selector components optimized for mobile and desktop interfaces

### 🔧 Technical Implementation

#### Core Components Added

- **`app/core/mtl.py`**: Multilingual support module with language constants and utilities
- **Language Resolution**: `resolve_voice_path_and_language()` function for automatic language detection
- **Model Loading**: Automatic multilingual vs standard model selection based on configuration
- **Language Validation**: Comprehensive validation against supported language codes

#### Frontend Components Added

- **Language Selection Components**: Dropdown selectors with native names and flag emojis
- **Language Display Utilities**: Consistent language representation across the interface
- **Voice Upload Enhancements**: Integrated language selection in upload modal
- **Language Constants**: Complete mapping of language codes to names and flags

#### Database & Storage

- **Voice Metadata Enhancement**: Extended voice storage to include language information
- **Backward Compatibility**: Existing voices automatically assigned English (`"en"`) language
- **Migration Support**: Seamless upgrade path for existing voice libraries

### 🚀 Breaking Changes

#### Dependency Updates

- **chatterbox-tts Version**: Upgraded from `1.0.4` to `0.1.4` (breaking change requiring dependency update)
- **Model Architecture**: New multilingual model may require initial download and setup
- **Python Compatibility**: Enhanced compatibility testing for Python 3.11+ environments

### 📚 Documentation

#### New Documentation

- **`docs/MULTILINGUAL.md`**: Comprehensive multilingual feature documentation with API reference
- **`docs/MULTILINGUAL_TESTING_GUIDE.md`**: Step-by-step testing guide for multilingual functionality
- **README Updates**: Enhanced main documentation with multilingual usage examples and configuration guide

#### API Documentation

- **Language Endpoints**: Complete API reference for new language-related endpoints
- **Usage Examples**: Multilingual examples in multiple programming languages
- **Migration Guide**: Instructions for upgrading existing installations to multilingual support

### 🔄 Migration Notes

#### For Existing Users

- **Automatic Upgrade**: Multilingual support is enabled by default for new installations
- **Existing Voices**: All existing voices continue to work unchanged (default to English)
- **Configuration**: Set `USE_MULTILINGUAL_MODEL=false` to disable multilingual support if needed
- **Dependencies**: Run `uv sync` or `pip install -r requirements.txt` to update to new chatterbox-tts version

#### Compatibility

- **API Compatibility**: All existing API endpoints remain unchanged and fully compatible
- **Voice Library**: Existing voice libraries are automatically migrated with language metadata
- **Frontend**: Existing frontend installations receive multilingual UI enhancements automatically

### 🎯 Performance

#### Model Optimization

- **Memory Management**: Optimized memory usage for multilingual model operations
- **Language Switching**: Efficient language switching without model reloading
- **Streaming Performance**: Maintained low-latency streaming across all supported languages

#### Quality Improvements

- **Voice Quality**: Enhanced voice cloning quality with language-specific optimizations
- **Speech Synthesis**: Improved speech generation accuracy for non-English languages
- **Cross-lingual Support**: Better handling of mixed-language content

---

## [1.6.1] - 2025-09-06

### Fixed

- **Dependency Pinning for `chatterbox-tts`**: Pinned the `chatterbox-tts` dependency to a specific version across all installation methods (`pip`, `uv pip`, `requirements.txt`, Dockerfiles). This ensures continued functionality and prevents breakage from recent upstream changes in the Resemble AI chatterbox library.

### Added

- **Experimental Blackwell GPU Support**: Introduced a new, experimental Docker configuration for users with NVIDIA Blackwell GPUs. While functionality is not guaranteed, it provides a template for running the service on this new architecture, both within Docker and as a guide for local setups.

---

## [1.6.0] - 2025-07-02

### Added

- **SSE Streaming**: Introduction of Server-Side Events (SSE) streaming functionality for real-time audio generation that more closely aligns with the OpenAI Speech API endpoint
- **Frontend Streaming**: New frontend functionality to opt to stream the audio (while also being able to download the full audio at the end of the stream)

### Updated

- Python tests for the SSE events and for the frontend streaming

---

## [1.5.0] - 2025-06-23

### Added

- **Memory Management Page**: New frontend page for monitoring and managing backend memory usage
- **Memory Management API Endpoints**: New endpoints for memory info, cleanup, reset, and recommendations
- **Navigation System**: Added Wouter-based routing between TTS and Memory Management pages
- **Real-time Memory Monitoring**: Live tracking of CPU and GPU memory usage with trend charts
- **Memory Alerts & Recommendations**: Intelligent alerts and optimization suggestions

### Enhanced

- **Frontend Polish**: Improved color schemes and visual consistency across components
- **Memory Cleanup**: More robust memory management with configurable cleanup intervals
- **User Experience**: Better responsive design and error handling

---

## [1.4.1] - 2025-06-22

### Added

- **Voice Alias System**: Add multiple aliases to any voice with persistent storage and UI management
- **OpenAI Voice Mapping**: Map OpenAI voice names (alloy, echo, fable, etc.) to custom voices via aliases
- **Alias API Endpoints**: New endpoints for adding, removing, and listing voice aliases
- **Alias UI Management**: Visual alias badges with inline editing and one-click removal

### Fixed

- **Default Voice Persistence**: Fixed default voice settings not persisting across frontend and backend sessions
- **Voice Resolution**: Improved voice name resolution to handle both direct names and aliases
- **Voice Library State**: Better synchronization between frontend and backend voice library state
- **Error Handling**: Enhanced error handling for voice operations and alias conflicts

---

## [1.4.0] - 2025-06-18

### Added

#### Voice Library Management System

- **Comprehensive Voice CRUD Operations**:
  - Voice upload with automatic validation and storage
  - Voice retrieval with metadata and file serving
  - Voice deletion with cleanup and validation
  - Voice renaming with conflict detection
  - List all voices with detailed metadata
- **Voice Storage Infrastructure**:
  - Persistent voice storage with configurable directories
  - Environment-based configuration for voice storage paths
  - Automatic voice file organization and cleanup
  - Safe file handling with validation and sanitization

#### New API Endpoints

- **Voice Management Endpoints**:
  - `POST /voices/upload` - Upload custom voice samples with metadata
  - `GET /voices` - List all available voices with details
  - `GET /voices/{voice_name}` - Retrieve specific voice information
  - `GET /voices/{voice_name}/file` - Download voice file
  - `DELETE /voices/{voice_name}` - Delete voice with confirmation
  - `PUT /voices/{voice_name}/rename` - Rename voice with validation
- **Enhanced Health Checks**:
  - Improved health endpoint with voice storage validation
  - System status checks including voice directory health
  - Enhanced API information with voice library status

#### Default Voice Management

- **Default Voice System**:
  - Configurable default voice selection and management
  - Automatic fallback to system default when custom default unavailable
  - Default voice validation and health monitoring
  - Environment-based default voice configuration
- **Voice Configuration**:
  - Persistent default voice settings across sessions
  - Voice availability validation and error handling
  - Seamless integration with existing TTS endpoints

#### Frontend Voice Library Integration

- **Voice Library Components**:
  - Interactive voice library management interface
  - Voice upload modal with validation and feedback
  - Voice selection dropdown with default voice indicator
  - Voice deletion confirmation with safety checks
- **Voice Library Management**:
  - Real-time voice library updates and synchronization
  - Voice metadata display including file size and type
  - Drag-and-drop voice upload support
  - Voice preview and testing capabilities
- **Default Voice Settings**:
  - Default voice selector with persistent settings
  - Visual indicators for default voice status
  - Automatic UI updates when default voice changes
  - Voice availability status in the interface

### Enhanced

#### Backend Improvements

- **Voice Storage Architecture**:
  - Robust file system integration with proper error handling
  - Thread-safe voice operations with proper locking
  - Enhanced validation for voice file formats and quality
  - Automatic cleanup of orphaned voice files
- **Configuration Management**:
  - Environment variable support for voice storage configuration
  - Configurable voice directory paths and permissions
  - Enhanced configuration validation and error reporting
  - Better default value management for voice settings

#### API Architecture

- **Enhanced Request Validation**:
  - Comprehensive voice parameter validation
  - File upload validation with size and format checks
  - Voice name sanitization and conflict detection
  - Improved error messages and status codes
- **Response Models**:
  - Structured voice metadata response models
  - Enhanced voice list responses with detailed information
  - Better error response formatting for voice operations
  - Consistent API response patterns across voice endpoints

#### Frontend Enhancements

- **User Experience Improvements**:
  - Intuitive voice management workflows
  - Real-time feedback for voice operations
  - Enhanced loading states and progress indicators
  - Better error handling and user notifications
- **State Management**:
  - Centralized voice library state management
  - Optimistic updates for voice operations
  - Real-time synchronization with backend voice changes
  - Persistent voice preferences and settings

### Technical Details

#### New Functions Added

- `upload_voice()` - Voice upload handler with validation
- `get_voices()` - Voice listing with metadata retrieval
- `get_voice_file()` - Voice file serving and download
- `delete_voice()` - Safe voice deletion with cleanup
- `rename_voice()` - Voice renaming with conflict checking
- `set_default_voice()` - Default voice management
- `validate_voice_file()` - Voice file validation and processing

#### Configuration Enhancements

- Voice storage directory configuration via environment variables
- Default voice management through configuration system
- Enhanced health checks with voice storage validation
- Voice-related environment variable documentation

#### Frontend Components Added

- `VoiceLibrary` - Main voice library management component
- `VoiceUploadModal` - Voice upload interface with validation
- `useVoiceLibrary` - Custom hook for voice library operations
- `useDefaultVoice` - Custom hook for default voice management
- Voice-related utilities and helpers for file handling

### Infrastructure

- **Environment Configuration**: Enhanced environment variable support for voice storage
- **Documentation**: Updated API documentation with voice library endpoints
- **Testing**: Extended test coverage for voice management operations
- **Validation**: Comprehensive voice file and parameter validation

---

## [1.3.0] - 2025-06-15

### Added

#### Real-time Audio Streaming

- **New Streaming Endpoints**:
  - `POST /audio/speech/stream` - Real-time streaming with configured voice sample
  - `POST /audio/speech/stream/upload` - Real-time streaming with custom voice upload
  - Chunked transfer encoding for true streaming experience
  - WAV header optimization for streaming compatibility

#### Advanced Streaming Features

- **Streaming Strategies**:
  - `sentence` (default) - Splits at sentence boundaries for natural flow
  - `paragraph` - Splits at paragraph breaks for longer contexts
  - `fixed` - Fixed character count chunks for predictable timing
  - `word` - Word-boundary splitting for maximum responsiveness
- **Quality Presets**:
  - `fast` mode - Optimized for low latency with smaller chunks
  - `balanced` mode (default) - Good balance of speed and quality
  - `high` mode - Larger chunks for better audio quality
- **Configurable Parameters**:
  - `streaming_chunk_size` (50-500) - Characters per streaming chunk
  - `streaming_buffer_size` (1-10) - Number of chunks to buffer
  - `streaming_quality` - Quality preset selection

#### Enhanced Text Processing

- **Streaming-Optimized Text Splitting**:
  - `split_text_for_streaming()` function with strategy-based chunking
  - `get_streaming_settings()` for optimized parameter management
  - Enhanced sentence, paragraph, and word boundary detection
  - Smart long-sentence splitting with natural break points
- **Memory-Efficient Processing**:
  - Chunk-by-chunk processing to reduce memory footprint
  - Automatic cleanup of processed audio chunks
  - Progressive WAV streaming without full concatenation

#### Progress Monitoring Integration

- **Real-time Progress Tracking**:
  - Enhanced status system with streaming-specific progress updates
  - Chunk-by-chunk progress reporting with percentage completion
  - Strategy-aware progress descriptions (e.g., "Streaming audio for chunk 3/8 (sentence strategy)")
  - Memory usage tracking during streaming operations

#### Documentation & Examples

- **Comprehensive Streaming Documentation**:
  - New `docs/STREAMING_API.md` with detailed streaming guide
  - Performance comparison between streaming and standard generation
  - Advanced usage examples in Python, JavaScript, and cURL
  - Real-time playback examples with pyaudio and Web Audio API
- **Updated Main Documentation**:
  - Streamlined streaming section in main README
  - Clear navigation to detailed streaming documentation
  - Updated API endpoints table with streaming links

### Enhanced

#### Backend Improvements

- **Streaming Implementation**:
  - `generate_speech_streaming()` async generator for true streaming
  - WAV header handling for streaming compatibility
  - Memory management optimized for streaming workflows
  - Automatic cleanup of temporary voice files during streaming
- **Error Handling**:
  - Streaming-specific error handling and status updates
  - Graceful fallback for streaming failures
  - Enhanced validation for streaming parameters

#### Performance Optimizations

- **Memory Management**:
  - Reduced memory usage through progressive processing
  - Automatic tensor cleanup during streaming
  - CUDA memory optimization for streaming workflows
- **Latency Improvements**:
  - First audio chunk available in 1-2 seconds
  - Progressive audio delivery eliminates wait times
  - Optimized chunking strategies for different use cases

### Technical Details

#### New Functions Added

- `generate_speech_streaming()` - Core streaming generator function
- `split_text_for_streaming()` - Strategy-based text splitting for streaming
- `get_streaming_settings()` - Optimized parameter management
- `_split_by_paragraphs()`, `_split_by_sentences()`, `_split_by_words()`, `_split_by_fixed_size()` - Strategy implementations

#### API Enhancements

- **Streaming Request Models**:
  - Extended `TTSRequest` model with streaming parameters
  - Validation for streaming strategies and quality presets
  - Form-data support for streaming with voice upload
- **Response Handling**:
  - Chunked transfer encoding headers
  - Streaming-optimized content headers
  - Progressive WAV format streaming

#### Frontend Integration

- **Updated Examples**:
  - Real-time streaming examples in multiple languages
  - Progress monitoring integration examples
  - Performance optimization guidelines
- **API Reference**:
  - Complete streaming parameter documentation
  - Performance comparison tables
  - Troubleshooting guide for streaming issues

### Infrastructure

- **Testing**: Extended test coverage for streaming endpoints
- **Documentation**: Comprehensive streaming API documentation
- **Examples**: Production-ready streaming integration examples

---

## [1.2.0] - 2025-06-14

### Added

- Version management system with automatic version reading from `pyproject.toml`
- Frontend and backend version display in the UI
- Comprehensive changelog documentation

#### Status API & Monitoring

- **Real-time TTS Processing Status API** with comprehensive endpoints:
  - `/status` - Main status endpoint with configurable details
  - `/status/progress` - Lightweight progress monitoring
  - `/status/statistics` - Processing metrics and performance stats
  - `/status/history` - Request history with detailed records
  - `/info` - Comprehensive API information endpoint
- **Advanced Status Tracking System**:
  - Thread-safe status manager with request lifecycle tracking
  - Progress percentage calculation with chunk-by-chunk monitoring
  - Processing statistics including success rates and performance metrics
  - Request history with detailed metadata and text previews
  - Memory usage tracking integration
- **Enhanced API Information**:
  - Version management with automatic `pyproject.toml` integration
  - Comprehensive API metadata including author, license, and platform info
  - Real-time server status and configuration details

#### Frontend Enhancements

- **Modern UI Framework Integration**:
  - Full shadcn/ui component library integration
  - Responsive design with mobile-first approach
  - Improved color system with dark/light mode support
  - Enhanced accessibility with proper ARIA labels and focus management
- **Advanced Status Monitoring Dashboard**:
  - Real-time status header with live processing updates
  - Interactive statistics panel with processing metrics
  - Progress overlay with visual chunk progression
  - Request history viewer with detailed request information
- **Enhanced User Experience**:
  - Responsive dialog-drawer modal system for mobile optimization
  - Improved form controls with better validation feedback
  - Advanced settings panel with real-time parameter adjustment
  - Voice library management with upload, rename, and delete capabilities
- **State Management Improvements**:
  - Centralized API state management with React Query
  - Real-time data synchronization across components
  - Optimistic updates for better user experience
  - Comprehensive error handling and retry mechanisms

### Enhanced

#### Backend Improvements

- **Memory Management System**:
  - Advanced memory monitoring with detailed usage tracking
  - Automatic cleanup routines for CUDA and CPU memory
  - Memory optimization for long-running processes
  - Configurable cleanup intervals and monitoring settings
- **API Architecture**:
  - Comprehensive endpoint aliasing system for backward compatibility
  - Enhanced request/response validation with Pydantic models
  - Improved error handling and status reporting
  - Better FastAPI documentation with detailed endpoint descriptions

#### Developer Experience

- **Docker Infrastructure**:
  - Multiple Docker Compose configurations for different deployment scenarios
  - GPU-optimized containers with CUDA support
  - uv-based builds for faster dependency resolution
  - Production-ready container configurations
- **Configuration Management**:
  - Environment variable validation and type checking
  - Comprehensive configuration endpoints for debugging
  - Better default values and configuration documentation
  - Runtime configuration updates for development

### Technical Details

#### API Endpoints Added

- `GET /status` - Main status with optional memory, history, and stats
- `GET /status/progress` - Lightweight progress monitoring
- `GET /status/statistics` - Processing metrics and performance data
- `GET /status/history` - Request history with configurable limits
- `POST /status/history/clear` - Clear request history with confirmation
- `GET /info` - Comprehensive API information and version details

#### Frontend Components Added

- `StatusHeader` - Real-time status display with API version
- `StatusProgressOverlay` - Visual progress tracking during generation
- `StatusStatisticsPanel` - Interactive statistics dashboard
- `useStatusMonitoring` - Custom hook for real-time status updates
- Version management utilities for frontend/backend version tracking

#### Configuration Enhancements

- Version management with `app/core/version.py`
- Enhanced `/config` endpoint with API metadata
- Frontend version utilities with build-time integration
- Comprehensive version display in UI components

### Infrastructure

- **Versioning System**: Automatic version reading from `pyproject.toml` with fallback support
- **Build Optimization**: uv integration for faster builds and better dependency resolution
- **Documentation**: Enhanced API documentation with detailed endpoint descriptions
- **Testing**: Extended test suite for status endpoints and memory management

---

## [1.0.0] - 2025-06-XX

### Added

- Initial release of Chatterbox TTS API
- FastAPI-based REST API with OpenAI compatibility
- Voice cloning capabilities with custom voice samples
- Docker containerization support
- React-based web frontend
- Basic health monitoring and configuration endpoints
- Memory management system
- Text processing with automatic chunking
- Multi-format audio support (MP3, WAV, FLAC, M4A, OGG)

### Core Features

- OpenAI-compatible `/v1/audio/speech` endpoint
- Voice file upload support via `/v1/audio/speech/upload`
- Health check endpoint `/health`
- Models listing endpoint `/v1/models`
- Configuration endpoint `/config`
- Memory management endpoint `/memory`

### Frontend Features

- Text-to-speech interface with parameter controls
- Voice library management
- Audio history and playback
- Advanced settings panel
- Theme support (light/dark mode)
- Responsive design

---

## Version Format

This project uses semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Incompatible API changes
- **MINOR**: New functionality in a backwards compatible manner
- **PATCH**: Backwards compatible bug fixes

### Backend vs Frontend Versioning

- **Backend API Version**: Follows the main project version (currently 1.2.0)
- **Frontend Version**: Independent versioning for UI updates (currently 1.1.0)
- **Display**: Backend version shown in status header, frontend version in footer

---

## Links

- [GitHub Repository](https://github.com/travisvn/chatterbox-tts-api)
- [API Documentation](docs/API_README.md)
- [Docker Guide](docs/DOCKER_README.md)
- [Status API Documentation](docs/STATUS_API.md)
