"""
TTS processing status endpoints
"""

from typing import Optional, Dict, Any, List
from fastapi import APIRouter, Query

from app.models import TTSStatusResponse, TTSStatisticsResponse, APIInfoResponse
from app.core import (
    add_route_aliases,
    get_tts_status,
    get_tts_history,
    get_tts_statistics,
    clear_tts_history,
    get_memory_info,
    get_version,
    get_version_info
)

# Create router with aliasing support
base_router = APIRouter()
router = add_route_aliases(base_router)


@router.get(
    "/status",
    response_model=TTSStatusResponse,
    summary="Get TTS processing status",
    description="Get current TTS processing status, progress, and information"
)
async def get_processing_status(
    include_memory: bool = Query(False, description="Include memory usage information"),
    include_history: bool = Query(False, description="Include recent request history"),
    include_stats: bool = Query(False, description="Include processing statistics"),
    history_limit: int = Query(5, description="Number of history records to return", ge=1, le=20)
) -> Dict[str, Any]:
    """Get comprehensive TTS processing status information"""
    
    # Get base status
    status = get_tts_status()
    
    # Add memory information if requested
    if include_memory:
        try:
            status["memory_info"] = get_memory_info()
        except Exception as e:
            status["memory_info"] = {"error": f"Failed to get memory info: {str(e)}"}
    
    # Add request history if requested
    if include_history:
        try:
            status["request_history"] = get_tts_history(history_limit)
        except Exception as e:
            status["request_history"] = {"error": f"Failed to get history: {str(e)}"}
    
    # Add processing statistics if requested
    if include_stats:
        try:
            status["statistics"] = get_tts_statistics()
        except Exception as e:
            status["statistics"] = {"error": f"Failed to get statistics: {str(e)}"}
    
    return status


@router.get(
    "/status/progress",
    summary="Get current TTS progress",
    description="Get current TTS request progress information (lightweight endpoint)"
)
async def get_tts_progress() -> Dict[str, Any]:
    """Get current TTS progress information"""
    status = get_tts_status()
    
    # Return simplified progress info
    if status.get("is_processing", False):
        progress = status.get("progress", {})
        return {
            "is_processing": True,
            "status": status.get("status"),
            "current_step": progress.get("current_step", ""),
            "current_chunk": progress.get("current_chunk", 0),
            "total_chunks": progress.get("total_chunks", 0),
            "progress_percentage": progress.get("progress_percentage", 0),
            "duration_seconds": status.get("duration_seconds", 0),
            "estimated_completion": progress.get("estimated_completion"),
            "text_preview": status.get("text_preview", "")
        }
    else:
        return {
            "is_processing": False,
            "status": "idle",
            "message": "No active TTS requests"
        }


@router.get(
    "/status/history",
    summary="Get TTS request history",
    description="Get recent TTS request history with details"
)
async def get_request_history(
    limit: int = Query(10, description="Number of history records to return", ge=1, le=50)
) -> Dict[str, Any]:
    """Get TTS request history"""
    history = get_tts_history(limit)
    
    return {
        "request_history": history,
        "total_records": len(history),
        "limit": limit
    }


@router.get(
    "/status/statistics",
    response_model=TTSStatisticsResponse,
    summary="Get TTS processing statistics",
    description="Get comprehensive TTS processing statistics and performance metrics"
)
async def get_processing_statistics(
    include_memory: bool = Query(False, description="Include current memory usage")
) -> Dict[str, Any]:
    """Get TTS processing statistics"""
    stats = get_tts_statistics()
    
    if include_memory:
        try:
            stats["current_memory"] = get_memory_info()
        except Exception as e:
            stats["current_memory"] = {"error": f"Failed to get memory info: {str(e)}"}
    
    return stats


@router.post(
    "/status/history/clear",
    summary="Clear TTS request history",
    description="Clear the TTS request history (keeps current active request)"
)
async def clear_request_history(
    confirm: bool = Query(False, description="Confirmation required to clear history")
) -> Dict[str, Any]:
    """Clear TTS request history"""
    if not confirm:
        return {
            "message": "History clear requires confirmation. Set confirm=true to proceed.",
            "warning": "This will clear all request history except the current active request."
        }
    
    try:
        clear_tts_history()
        return {
            "success": True,
            "message": "TTS request history cleared successfully"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to clear history: {str(e)}"
        }


@router.get(
    "/info",
    response_model=APIInfoResponse,
    summary="Get API info and status",
    description="Get comprehensive API information including TTS status, memory, and statistics"
)
async def get_api_info() -> Dict[str, Any]:
    """Get comprehensive API information"""
    try:
        # Get version information
        version_info = get_version_info()
        
        # Get all information
        tts_status = get_tts_status()
        tts_stats = get_tts_statistics()
        memory_info = get_memory_info()
        recent_history = get_tts_history(3)  # Last 3 requests
        
        return {
            "api_name": version_info.get("name", "Chatterbox TTS API"),
            "version": version_info["version"],
            "api_version": version_info["api_version"],
            "description": version_info.get("description", ""),
            "status": "operational",
            "version_info": version_info,
            "tts_status": tts_status,
            "statistics": tts_stats,
            "memory_info": memory_info,
            "recent_requests": recent_history,
            "uptime_info": {
                "total_requests": tts_stats.get("total_requests", 0),
                "success_rate": tts_stats.get("success_rate", 0),
                "is_processing": tts_status.get("is_processing", False)
            }
        }
    except Exception as e:
        version = get_version()
        return {
            "api_name": "Chatterbox TTS API",
            "version": version,
            "api_version": version,
            "status": "error",
            "error": f"Failed to get API info: {str(e)}"
        }


# Export the base router for the main app to use
__all__ = ["base_router"] 