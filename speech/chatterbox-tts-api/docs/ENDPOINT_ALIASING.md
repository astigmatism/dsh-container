# Endpoint Aliasing in FastAPI

This document explains how to create endpoint aliases in your FastAPI application, allowing multiple URLs to point to the same endpoint function.

## Why Endpoint Aliasing?

Endpoint aliasing is useful for:

- **API Versioning**: Supporting both `/v1/endpoint` and `/endpoint` patterns
- **Backward Compatibility**: Maintaining old endpoints while introducing new ones
- **OpenAI Compatibility**: Matching OpenAI API paths while providing your own convention

## Method 1: Multiple Decorators (Simple)

The most straightforward approach is using multiple decorators on the same function:

```python
@router.post(
    "/v1/audio/speech",
    response_class=StreamingResponse,
    summary="Generate speech from text"
)
@router.post("/audio/speech", include_in_schema=False)  # Alias endpoint
async def text_to_speech(request: TTSRequest):
    """Generate speech from text"""
    # Implementation here
    pass
```

**Pros:**

- Simple and explicit
- Easy to understand
- No additional dependencies

**Cons:**

- Repetitive for many endpoints
- Easy to forget `include_in_schema=False`
- Harder to maintain large numbers of aliases

## Method 2: Centralized Aliasing System (Recommended)

We've created a centralized system in `app/core/aliases.py`:

### Configuration

```python
# app/core/aliases.py
# Format: "primary_endpoint": ["alias1", "alias2", ...]
ENDPOINT_ALIASES = {
    "/audio/speech": ["/v1/audio/speech"],
    "/audio/speech/upload": ["/v1/audio/speech/upload"],
    "/health": ["/v1/health"],
    "/models": ["/v1/models"],
    "/config": ["/v1/config"],
    "/endpoints": ["/v1/endpoints"],
    "/memory": ["/v1/memory"],
    "/memory/reset": ["/v1/memory/reset"],
}
```

### Usage Example

```python
from fastapi import APIRouter
from app.core import add_route_aliases

# Create router with aliasing support
base_router = APIRouter()
router = add_route_aliases(base_router)

@router.get(
    "/config",
    response_model=ConfigResponse,
    summary="Get configuration"
)
async def get_config():
    """Get current configuration"""
    # Implementation here
    pass

# This automatically creates both:
# - /config (primary, included in schema)
# - /v1/config (alias, excluded from schema)
```

### Important: Export base_router

When using the aliasing system, export the `base_router` for the main application:

```python
# At the end of your endpoint file
__all__ = ["base_router"]
```

And update your main router:

```python
# app/api/router.py
api_router.include_router(config.base_router, tags=["Configuration"])
```

## Method 3: Manual Alias Route Decorator

For one-off aliases or custom behavior:

```python
from app.core import alias_route

@alias_route("/v1/custom/endpoint", "/custom/endpoint")
@router.get()
async def custom_endpoint():
    pass
```

## Managing Aliases

### View All Aliases

```python
from app.core import get_all_aliases

aliases = get_all_aliases()
print(aliases)
```

### Add Runtime Aliases

```python
from app.core import add_custom_alias

add_custom_alias("/v1/new/endpoint", "/new/endpoint")
```

### Remove Aliases

```python
from app.core import remove_alias

remove_alias("/v1/endpoint")
```

## Current Project Structure

Your project now uses **Method 2** consistently across all endpoints:

- **Speech endpoints**: `speech.py`

  - `/audio/speech` → ["/v1/audio/speech"]
  - `/audio/speech/upload` → ["/v1/audio/speech/upload"]

- **Health endpoint**: `health.py`

  - `/health` → ["/v1/health"]

- **Models endpoint**: `models.py`

  - `/models` → ["/v1/models"]

- **Config endpoint**: `config.py`

  - `/config` → ["/v1/config"]
  - `/endpoints` → ["/v1/endpoints"]

- **Memory endpoints**: `memory.py`
  - `/memory` → ["/v1/memory"]
  - `/memory/reset` → ["/v1/memory/reset"]

## Migration Recommendations

### For New Endpoints

Use **Method 2** (centralized system) for consistency and maintainability.

### For Existing Endpoints

You can keep using **Method 1** or gradually migrate to **Method 2**. Both approaches work seamlessly together.

### Best Practices

1. **Primary endpoints** should use clean, short paths (no `/v1/` prefix) and be included in schema
2. **Alias endpoints** should use `/v1/` prefix for OpenAI compatibility and be excluded from schema
3. **Document your aliases** in the `ENDPOINT_ALIASES` configuration
4. **Use consistent naming** across your API
5. **Support multiple aliases** per endpoint for maximum flexibility

## Testing Aliases

Both endpoints should work identically:

```bash
# Primary endpoint (recommended)
curl -X POST "http://localhost:8000/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello world"}'

# Alias endpoint (OpenAI compatibility - same result)
curl -X POST "http://localhost:8000/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello world"}'
```

## OpenAPI Schema

Only primary endpoints appear in the automatically generated documentation at `/docs`, keeping it clean while maintaining backward compatibility.
