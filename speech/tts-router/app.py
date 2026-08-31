import asyncio
import os
import time
import uuid
from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field


APP_NAME = "openwebui-voice-tts-router"

TTS_ROUTER_API_KEY = os.getenv("TTS_ROUTER_API_KEY", "")
KOKORO_BASE_URL = os.getenv("KOKORO_BASE_URL", "http://kokoro-tts:8880/v1").rstrip("/")
CHATTERBOX_BASE_URL = os.getenv("CHATTERBOX_BASE_URL", "http://chatterbox-tts:4123/v1").rstrip("/")
DEFAULT_TTS_BACKEND = os.getenv("DEFAULT_TTS_BACKEND", "kokoro").lower()
CHATTERBOX_TIMEOUT_SECONDS = float(os.getenv("CHATTERBOX_TIMEOUT_SECONDS", "180"))
KOKORO_TIMEOUT_SECONDS = float(os.getenv("KOKORO_TIMEOUT_SECONDS", "60"))
CHATTERBOX_QUEUE_TIMEOUT_SECONDS = float(os.getenv("CHATTERBOX_QUEUE_TIMEOUT_SECONDS", "30"))
CHATTERBOX_CONCURRENCY = int(os.getenv("CHATTERBOX_CONCURRENCY", "1"))
CHATTERBOX_SEMAPHORE = asyncio.Semaphore(CHATTERBOX_CONCURRENCY)


class SpeechRequest(BaseModel):
    model: Optional[str] = Field(default="tts-1")
    voice: Optional[str] = Field(default="af_heart")
    input: str
    response_format: Optional[str] = Field(default="mp3")
    speed: Optional[float] = Field(default=1.0)

    class Config:
        extra = "allow"


app = FastAPI(title=APP_NAME)


def authorize(authorization: Optional[str]) -> None:
    if not TTS_ROUTER_API_KEY:
        return

    expected = f"Bearer {TTS_ROUTER_API_KEY}"
    if authorization != expected:
        raise HTTPException(
            status_code=401,
            detail={"error": {"message": "Unauthorized", "type": "auth_error"}},
        )


def select_backend(payload: SpeechRequest) -> str:
    voice = (payload.voice or "").lower()
    model = (payload.model or "").lower()

    if voice.startswith(("chatterbox:", "clone:", "cb:")):
        return "chatterbox"

    if model in {"chatterbox", "chatterbox-tts-1"}:
        return "chatterbox"

    return DEFAULT_TTS_BACKEND if DEFAULT_TTS_BACKEND in {"kokoro", "chatterbox"} else "kokoro"


async def acquire_chatterbox_slot(request_id: str) -> bool:
    try:
        await asyncio.wait_for(CHATTERBOX_SEMAPHORE.acquire(), timeout=CHATTERBOX_QUEUE_TIMEOUT_SECONDS)
        return True
    except asyncio.TimeoutError:
        print(f"request_id={request_id} backend=chatterbox status=queue_timeout")
        return False


def normalize_for_backend(payload: SpeechRequest, backend: str) -> Dict[str, Any]:
    data = payload.model_dump(exclude_none=True)

    if backend == "chatterbox":
        voice = data.get("voice")
        if isinstance(voice, str):
            for prefix in ("chatterbox:", "clone:", "cb:"):
                if voice.lower().startswith(prefix):
                    stripped = voice.split(":", 1)[1].strip()
                    data["voice"] = stripped or "alloy"
                    break

        # Chatterbox always returns WAV today, so ask for WAV explicitly.
        data["response_format"] = "wav"
        data.pop("model", None)

    return data


async def forward_speech(payload: SpeechRequest, backend: str) -> Response:
    if backend == "chatterbox":
        base_url = CHATTERBOX_BASE_URL
        timeout = CHATTERBOX_TIMEOUT_SECONDS
    else:
        base_url = KOKORO_BASE_URL
        timeout = KOKORO_TIMEOUT_SECONDS

    upstream_url = f"{base_url}/audio/speech"
    request_id = str(uuid.uuid4())
    started = time.monotonic()
    forwarded_payload = normalize_for_backend(payload, backend)

    print(
        f"request_id={request_id} backend={backend} "
        f"model={payload.model} voice={payload.voice} "
        f"chars={len(payload.input)} upstream={upstream_url}"
    )

    acquired_chatterbox_slot = False

    if backend == "chatterbox":
        acquired_chatterbox_slot = await acquire_chatterbox_slot(request_id)
        if not acquired_chatterbox_slot:
            raise HTTPException(
                status_code=429,
                detail={
                    "error": {
                        "message": "Chatterbox is busy; queue timeout reached",
                        "type": "chatterbox_busy",
                    }
                },
            )

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            upstream = await client.post(upstream_url, json=forwarded_payload)
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "error": {
                    "message": f"{backend} backend request failed: {exc}",
                    "type": "backend_unavailable",
                }
            },
        ) from exc

    finally:
        if acquired_chatterbox_slot:
            CHATTERBOX_SEMAPHORE.release()

    elapsed_ms = int((time.monotonic() - started) * 1000)
    print(
        f"request_id={request_id} backend={backend} "
        f"status={upstream.status_code} latency_ms={elapsed_ms}"
    )

    content_type = upstream.headers.get("content-type", "application/octet-stream")

    if upstream.status_code >= 400:
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=content_type,
        )

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=content_type,
    )


@app.get("/healthz")
async def healthz() -> Dict[str, Any]:
    return {"status": "ok", "service": APP_NAME}


@app.get("/readyz")
async def readyz() -> Dict[str, Any]:
    results: Dict[str, Any] = {"status": "ready", "backends": {}}

    async with httpx.AsyncClient(timeout=5) as client:
        for name, url in {
            "kokoro": f"{KOKORO_BASE_URL.removesuffix('/v1')}/health",
            "chatterbox": f"{CHATTERBOX_BASE_URL.removesuffix('/v1')}/health",
        }.items():
            try:
                response = await client.get(url)
                results["backends"][name] = {
                    "ok": response.status_code < 400,
                    "status_code": response.status_code,
                }
            except Exception as exc:
                results["backends"][name] = {"ok": False, "error": str(exc)}

    if not all(item.get("ok") for item in results["backends"].values()):
        results["status"] = "degraded"

    return results


@app.get("/v1/models")
async def models(authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    authorize(authorization)
    return {
        "object": "list",
        "data": [
            {"id": "tts-1", "object": "model", "owned_by": "router"},
            {"id": "tts-1-hd", "object": "model", "owned_by": "router"},
            {"id": "kokoro", "object": "model", "owned_by": "kokoro"},
            {"id": "chatterbox", "object": "model", "owned_by": "chatterbox"},
            {"id": "chatterbox-tts-1", "object": "model", "owned_by": "chatterbox"},
        ],
    }


async def fetch_kokoro_voices() -> list[Dict[str, str]]:
    upstream_url = f"{KOKORO_BASE_URL}/audio/voices"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(upstream_url)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:
        print(f"voice_catalog backend=kokoro status=error error={exc}")
        return [{"id": "af_heart", "name": "Kokoro af_heart"}]

    if isinstance(data, dict):
        raw_voices = data.get("voices") or data.get("data") or []
    elif isinstance(data, list):
        raw_voices = data
    else:
        raw_voices = []

    voices: list[Dict[str, str]] = []
    for item in raw_voices:
        if isinstance(item, str):
            voice_id = item
            voice_name = item
        elif isinstance(item, dict):
            voice_id = item.get("id") or item.get("name")
            voice_name = item.get("name") or voice_id
        else:
            continue

        if voice_id:
            voices.append({"id": voice_id, "name": f"Kokoro {voice_name}"})

    voices.sort(key=lambda voice: voice["id"])
    return voices


async def fetch_chatterbox_voices() -> list[Dict[str, str]]:
    upstream_url = f"{CHATTERBOX_BASE_URL.removesuffix('/v1')}/voices"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(upstream_url)
            response.raise_for_status()
            data = response.json()
    except Exception as exc:
        print(f"voice_catalog backend=chatterbox status=error error={exc}")
        return [{"id": "chatterbox:alloy", "name": "Chatterbox default"}]

    raw_voices = data.get("voices") if isinstance(data, dict) else []
    voices: list[Dict[str, str]] = [{"id": "chatterbox:alloy", "name": "Chatterbox default"}]

    for item in raw_voices:
        if not isinstance(item, dict):
            continue

        voice_name = item.get("name")
        if voice_name:
            voices.append({
                "id": f"chatterbox:{voice_name}",
                "name": f"Chatterbox {voice_name}",
            })

        for alias in item.get("aliases") or []:
            if alias:
                voices.append({
                    "id": f"chatterbox:{alias}",
                    "name": f"Chatterbox {alias}",
                })

    seen: set[str] = set()
    unique_voices: list[Dict[str, str]] = []
    for voice in voices:
        if voice["id"] not in seen:
            seen.add(voice["id"])
            unique_voices.append(voice)

    unique_voices.sort(key=lambda voice: voice["id"])
    return unique_voices


@app.get("/v1/audio/voices")
async def audio_voices() -> Dict[str, Any]:
    voices = []
    voices.extend(await fetch_kokoro_voices())
    voices.extend(await fetch_chatterbox_voices())
    return {"voices": voices}


@app.get("/v1/audio/models")
async def audio_models() -> Dict[str, Any]:
    return {
        "models": [
            {"id": "tts-1", "name": "tts-1"},
            {"id": "tts-1-hd", "name": "tts-1-hd"},
        ]
    }



@app.post("/v1/audio/speech")
async def speech(
    payload: SpeechRequest,
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> Response:
    authorize(authorization)
    backend = select_backend(payload)
    return await forward_speech(payload, backend)
