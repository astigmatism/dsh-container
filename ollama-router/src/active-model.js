import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

function parseMarker(raw, filePath) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string' && parsed.model.trim()) {
      const hasSupportedThinkLevels = Object.hasOwn(parsed, 'supported_think_levels');
      const hasReasoningEffortMap = Object.hasOwn(parsed, 'reasoning_effort_map');
      return {
        model: parsed.model.trim(),
        profile: typeof parsed.profile === 'string' ? parsed.profile : null,
        keep_alive: parsed.keep_alive ?? null,
        default_think: Object.hasOwn(parsed, 'default_think') ? parsed.default_think : null,
        default_think_configured: Object.hasOwn(parsed, 'default_think') && parsed.default_think !== null,
        supported_think_levels: hasSupportedThinkLevels ? parsed.supported_think_levels : null,
        reasoning_effort_map: hasReasoningEffortMap ? parsed.reasoning_effort_map : null,
        reasoning_capabilities_configured: hasSupportedThinkLevels || hasReasoningEffortMap,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
        source: typeof parsed.source === 'string' ? parsed.source : filePath,
        raw: parsed
      };
    }
    return null;
  } catch {
    return {
      model: trimmed,
      profile: null,
      keep_alive: null,
      default_think: null,
      default_think_configured: false,
      supported_think_levels: null,
      reasoning_effort_map: null,
      reasoning_capabilities_configured: false,
      updated_at: null,
      source: filePath,
      raw: trimmed
    };
  }
}

export async function readActiveModel(config) {
  const filePath = config.activeModelFile;
  if (filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const marker = parseMarker(raw, filePath);
      if (marker?.model) {
        let mtime = null;
        try {
          mtime = statSync(filePath).mtime.toISOString();
        } catch {
          mtime = null;
        }
        return {
          ...marker,
          loadedFrom: 'file',
          file: filePath,
          file_mtime: mtime
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return {
          model: config.activeModelFallback || null,
          profile: null,
          keep_alive: null,
          default_think: null,
          default_think_configured: false,
          supported_think_levels: null,
          reasoning_effort_map: null,
          reasoning_capabilities_configured: false,
          updated_at: null,
          source: `fallback after marker read error: ${error.message}`,
          loadedFrom: config.activeModelFallback ? 'env-fallback' : 'missing',
          file: filePath,
          file_mtime: null,
          error: error.message
        };
      }
    }
  }

  if (config.activeModelFallback) {
    return {
      model: config.activeModelFallback,
      profile: null,
      keep_alive: null,
      default_think: null,
      default_think_configured: false,
      supported_think_levels: null,
      reasoning_effort_map: null,
      reasoning_capabilities_configured: false,
      updated_at: null,
      source: 'ACTIVE_MODEL environment fallback',
      loadedFrom: 'env-fallback',
      file: filePath,
      file_mtime: null
    };
  }

  return {
    model: null,
    profile: null,
    keep_alive: null,
    default_think: null,
    default_think_configured: false,
    supported_think_levels: null,
    reasoning_effort_map: null,
    reasoning_capabilities_configured: false,
    updated_at: null,
    source: 'no active model marker or ACTIVE_MODEL fallback',
    loadedFrom: 'missing',
    file: filePath,
    file_mtime: null
  };
}

export async function writeActiveModelMarker(filePath, marker) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    model: marker.model,
    profile: marker.profile ?? null,
    keep_alive: marker.keep_alive ?? -1,
    ...(marker.default_think === undefined ? {} : { default_think: marker.default_think }),
    ...(marker.supported_think_levels === undefined ? {} : { supported_think_levels: marker.supported_think_levels }),
    ...(marker.reasoning_effort_map === undefined ? {} : { reasoning_effort_map: marker.reasoning_effort_map }),
    updated_at: marker.updated_at ?? new Date().toISOString(),
    source: marker.source ?? 'local-ai-ollama-router'
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}
