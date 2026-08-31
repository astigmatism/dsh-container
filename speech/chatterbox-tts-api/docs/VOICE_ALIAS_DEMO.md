# Voice Alias System Demo

## Overview

The voice library now supports a comprehensive alias system that allows users to:

1. **Add multiple aliases to any voice** - No limit on the number of aliases per voice
2. **Map OpenAI voice names** (alloy, echo, fable, onyx, nova, shimmer) to custom voices
3. **Persistent storage** - All aliases are saved to the backend and restored on startup
4. **Unique constraints** - Aliases must be unique across all voices
5. **Full API support** - Complete REST API for alias management

## Backend Features

### New VoiceLibrary Methods

- `add_alias(voice_name, alias)` - Add an alias to a voice
- `remove_alias(voice_name, alias)` - Remove an alias from a voice
- `list_aliases(voice_name)` - Get all aliases for a voice
- `resolve_voice_name(name_or_alias)` - Resolve alias to actual voice name
- `get_all_voice_names()` - Get all names and aliases

### New API Endpoints

- `POST /voices/{voice_name}/aliases` - Add alias
- `DELETE /voices/{voice_name}/aliases/{alias}` - Remove alias
- `GET /voices/{voice_name}/aliases` - List aliases
- `GET /voices/all-names` - Get all voice names and aliases

### Voice Resolution Logic

The system now checks:

1. Direct voice name match
2. Alias lookup if no direct match
3. OpenAI voice fallback (with warning) if no alias mapping exists

## Frontend Features

### Visual Alias Management

- **Alias badges** - Show all aliases as small tags under voice names
- **Add alias button** - Quick "+" button to add new aliases
- **Remove alias** - Click "×" on any alias badge to remove it
- **Inline editing** - Add aliases directly in the voice library interface

### Smart Resolution

- Voice selection works with both names and aliases
- Default voice setting works with aliases
- TTS requests automatically resolve aliases to actual voices

## Usage Examples

### 1. Basic Alias Management

```javascript
// Add an alias
await ttsService.addAlias('my-custom-voice', 'john');

// Remove an alias
await ttsService.removeAlias('my-custom-voice', 'john');

// List aliases
const { aliases } = await ttsService.listAliases('my-custom-voice');
```

### 2. OpenAI Voice Mapping

```javascript
// Map OpenAI "alloy" voice to your custom voice
await ttsService.addAlias('sarah-voice', 'alloy');

// Now when users request "alloy", they get "sarah-voice"
const request = { input: 'Hello world', voice: 'alloy' };
// This will automatically use "sarah-voice" instead of the default
```

### 3. Multiple Aliases for One Voice

```javascript
// Add multiple aliases to the same voice
await ttsService.addAlias('professional-voice', 'business');
await ttsService.addAlias('professional-voice', 'corporate');
await ttsService.addAlias('professional-voice', 'presenter');
await ttsService.addAlias('professional-voice', 'alloy'); // OpenAI mapping

// All of these will resolve to the same voice:
// - "professional-voice" (original name)
// - "business", "corporate", "presenter" (custom aliases)
// - "alloy" (OpenAI voice mapping)
```

### 4. API Compatibility

The system maintains full backward compatibility:

```javascript
// These all work the same way:
{ input: "Hello", voice: "actual-voice-name" }     // Direct name
{ input: "Hello", voice: "my-alias" }              // Custom alias
{ input: "Hello", voice: "alloy" }                 // OpenAI voice (mapped or default)
{ input: "Hello" }                                 // No voice (uses default)
```

## UI Workflow

### Adding Aliases

1. Click the "+" button next to any voice in the library
2. Type the new alias name
3. Press Enter or click the checkmark to save
4. The alias appears as a tag under the voice name

### Removing Aliases

1. Find the alias tag under a voice name
2. Click the "×" button on the tag
3. The alias is immediately removed

### OpenAI Voice Mapping Workflow

1. Upload your custom voice to the library
2. Click "+" to add an alias
3. Type one of the OpenAI voice names: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`
4. Save the alias
5. Now when users request that OpenAI voice name, your custom voice will be used instead

## System Architecture

### Backend Storage

Aliases are stored in the voice metadata JSON file:

```json
{
  "voices": {
    "my-voice": {
      "name": "my-voice",
      "filename": "my-voice.wav",
      "aliases": ["john", "presenter", "alloy"],
      "upload_date": "2024-01-01T00:00:00",
      ...
    }
  }
}
```

### Frontend State Management

- Aliases are included in the VoiceSample type
- useVoiceLibrary hook provides alias management functions
- Voice Library component handles UI interactions
- Real-time updates via React Query invalidation

### Error Handling

- **Unique constraints**: Prevents duplicate aliases across voices
- **Validation**: Checks for invalid characters in alias names
- **Graceful fallbacks**: Falls back to default voice if resolution fails
- **User feedback**: Clear error messages for conflicts

## Future Enhancements

This system provides the foundation for:

1. **Bulk OpenAI mapping**: Quick setup to map all OpenAI voices at once
2. **Voice categories**: Group aliases by type (emotions, characters, etc.)
3. **API discovery**: Endpoint to list available voice names for external tools
4. **Import/export**: Backup and restore alias configurations
5. **Smart suggestions**: Suggest aliases based on voice characteristics

## Migration Notes

- **Backward compatibility**: All existing voices continue to work
- **Automatic initialization**: Empty `aliases: []` added to existing voices
- **No breaking changes**: All existing API endpoints work unchanged
- **Graceful degradation**: System works even if alias features aren't used

The alias system is fully operational and ready for production use!
