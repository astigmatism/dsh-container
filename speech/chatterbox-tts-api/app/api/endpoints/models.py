"""
Model listing endpoints (OpenAI compatibility)
"""

from fastapi import APIRouter

from app.models import ModelsResponse, ModelInfo
from app.core import add_route_aliases

# Create router with aliasing support
base_router = APIRouter()
router = add_route_aliases(base_router)


@router.get(
    "/models",
    response_model=ModelsResponse,
    summary="List models",
    description="List available models (OpenAI API compatibility)"
)
async def list_models():
    """List available models (OpenAI API compatibility)"""
    return ModelsResponse(
        object="list",
        data=[
            ModelInfo(
                id="chatterbox-tts-1",
                object="model", 
                created=1677649963,
                owned_by="resemble-ai"
            )
        ]
    )

# Export the base router for the main app to use
__all__ = ["base_router"] 