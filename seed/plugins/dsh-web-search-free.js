/**
 * dsh-web-search-free — keyless web search provider for the DSH web seam.
 * v2: fallback chain over keyless HTML endpoints:
 *   1. DuckDuckGo (https://html.duckduckgo.com/html/) — primary
 *   2. Bing     (https://www.bing.com/search)         — fallback
 *
 * No API key, no account, no cost — each search is a plain HTTP GET. If one
 * backend rate-limits or challenges this IP (DDG returns 202/403 challenges
 * for a few hours after bursts), the next endpoint in the chain serves the
 * search instead of failing.
 *
 * Local deployment plugin (NOT part of the published DSH distribution).
 * Loaded from the profile cordis.patch.yml via a relative specifier resolved
 * against the profile directory; the file lives in $DSH_HOME so it persists
 * across container restarts (the node_modules tree does not). The `?v=` query
 * on the specifier in the patch is an ESM import-cache buster: bump it when
 * replacing this file so live sessions pick up new code without a restart.
 *
 * Error policy: plain `Error` with an actionable message. The web seam passes
 * provider errors through to `dsh-tool-web`, which renders `Error: <message>`.
 */

/** Browser-like UAs: DDG/Bing reject the default node fetch UA. Rotated per
 *  request — DDG's anomaly detection keys challenges partly on (UA, IP). */
const USER_AGENTS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
];
/** Per-endpoint ceiling; the tool-level timeout the seam enforces still applies. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Cordis plugin identity. */
export const name = "web-search-duckduckgo";
/** Services this plugin requires: the web capability seam. */
export const inject = ["web"];

/**
 * Build the default endpoint chain.
 * @param config - entry config; optional `baseURL` overrides the primary
 *   DuckDuckGo endpoint, optional `endpoints` replaces the whole chain
 *   (array of { name, baseURL, engine }).
 */
function endpointsOf(config = {}) {
  const ddg = {
    name: "duckduckgo",
    baseURL: config.baseURL ?? "https://html.duckduckgo.com/html/",
    engine: "duckduckgo",
  };
  const bing = { name: "bing", baseURL: "https://www.bing.com/search", engine: "bing" };
  if (Array.isArray(config.endpoints) && config.endpoints.length > 0) {
    return config.endpoints
      .filter((entry) => entry && typeof entry.baseURL === "string" && URL.canParse(entry.baseURL))
      .map((entry, index) => ({
        name: typeof entry.name === "string" ? entry.name : `endpoint-${index + 1}`,
        baseURL: entry.baseURL,
        engine: entry.engine === "bing" ? "bing" : "duckduckgo",
      }));
  }
  return [ddg, bing];
}

/**
 * Keyless HTML-endpoint provider with a fallback chain.
 * A challenged/rate-limited endpoint (202/403/429) or network failure drops
 * through to the next endpoint; a clean 200 with zero results is authoritative.
 */
class DuckDuckGoSearchProvider {
  /** Stable id this provider registers under. */
  id = "duckduckgo";

  /** @param options - { endpoints: [...] } for the next operation. */
  constructor(options) {
    this.options = options;
  }

  /** Cheap local check: no credentials needed; at least one parseable endpoint. */
  available() {
    return this.options.endpoints.length > 0;
  }

  /**
   * Run one search across the endpoint chain.
   * @param request - { query, maxResults? } per the seam vocabulary.
   * @param signal - optional cancellation from the seam/tool.
   * @returns { sources: [{ url, title, snippet? }], truncated: false } — the
   *   seam enforces maxResults truncation itself.
   */
  async search(request, signal) {
    const failures = [];
    let cleanZero = false;
    for (const endpoint of this.options.endpoints) {
      if (signal?.aborted) throw new Error("web search aborted");
      const url =
        endpoint.engine === "bing"
          ? `${endpoint.baseURL}?q=${encodeURIComponent(request.query)}&count=10`
          : `${endpoint.baseURL}?q=${encodeURIComponent(request.query)}`;
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combined = signal !== void 0 ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            "user-agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
          },
          redirect: "follow",
          signal: combined,
        });
      } catch (error) {
        if (combined.aborted || error?.name === "AbortError") {
          if (signal?.aborted) throw new Error("web search aborted");
          failures.push(`${endpoint.name}: timed out after ${REQUEST_TIMEOUT_MS}ms`);
          continue;
        }
        failures.push(`${endpoint.name}: request failed (${String(error?.message ?? error)})`);
        continue;
      }
      if (response.status === 202 || response.status === 403 || response.status === 429) {
        failures.push(`${endpoint.name}: HTTP ${response.status} (rate-limited or challenged)`);
        continue;
      }
      if (!response.ok) {
        failures.push(`${endpoint.name}: HTTP ${response.status}`);
        continue;
      }
      const html = await response.text();
      const sources =
        endpoint.engine === "bing"
          ? parseBing(html, request.maxResults)
          : parseDuckDuckGo(html, request.maxResults);
      if (sources.length > 0) return { sources, truncated: false };
      cleanZero = true; // answered 200 with no results — authoritative
    }
    if (cleanZero) return { sources: [], truncated: false };
    throw new Error(`all search backends failed: ${failures.join("; ")}`);
  }
}

/**
 * Parse organic results out of the DDG HTML endpoint. Each organic result
 * lives in its own container div (`class="result results_links ..."`); per
 * block, the title anchor is `class="result__a"` and the snippet anchor is
 * `class="result__snippet"`.
 * @param html - full response body.
 * @param limit - optional early cutoff (the seam re-enforces maxResults).
 */
function parseDuckDuckGo(html, limit) {
  const sources = [];
  for (const block of html.split(/<div[^>]*class="result results_links/).slice(1)) {
    const title = /<a\b[^>]*class="result__a"([^>]*)>([\s\S]*?)<\/a>/.exec(block);
    if (!title) continue;
    const href = /\bhref="([^"]+)"/.exec(title[1])?.[1];
    if (!href) continue;
    const snippet = /<a\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const url = unwrapDuckDuckGo(href);
    if (!url) continue;
    sources.push({
      url,
      title: cleanText(title[2]),
      ...(snippet !== null && snippet[1] !== "" ? { snippet: cleanText(snippet[1]) } : {}),
    });
    if (limit !== void 0 && sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse organic results out of a Bing HTML search page. Each organic result
 * is an `<li class="b_algo">` block with an `<h2><a href>title</a></h2>` and
 * a first-`<p>` snippet. Result URLs are wrapped in `bing.com/ck/a` tracking
 * redirects carrying the real URL base64url-encoded in the `u=a1<...>` param.
 * @param html - full response body.
 * @param limit - optional early cutoff (the seam re-enforces maxResults).
 */
function parseBing(html, limit) {
  const sources = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(block);
    if (!h2) continue;
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/.exec(h2[1]);
    if (!anchor) continue;
    const href = /\bhref="([^"]+)"/.exec(decodeEntities(anchor[1]))?.[1];
    if (!href) continue;
    const url = unwrapBing(href);
    if (!url) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    sources.push({
      url,
      title: cleanText(anchor[2]),
      ...(snippet !== null && snippet[1] !== "" ? { snippet: cleanText(snippet[1]) } : {}),
    });
    if (limit !== void 0 && sources.length >= limit) break;
  }
  return sources;
}

/** DDG wraps organic URLs in a redirect: `//duckduckgo.com/l/?uddg=<encoded>&rut=...`. */
function unwrapDuckDuckGo(href) {
  let url = href;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https:${url.startsWith("//") ? url : `//${url}`}`;
  try {
    const parsed = new URL(url);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return parsed.href;
  } catch {
    return href;
  }
}

/**
 * Bing wraps organic URLs in `https://www.bing.com/ck/a?...&u=a1<base64url>`.
 * Decode the `u` param to the real URL; drop undecodable tracking links.
 */
function unwrapBing(href) {
  try {
    const parsed = new URL(href);
    const marker = /[?&]u=([^&]+)/.exec(href);
    if (parsed.hostname.endsWith("bing.com") && marker) {
      const raw = marker[1].replace(/^a\d+/, "");
      const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64url").toString("utf8");
      if (URL.canParse(decoded)) return decoded;
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/** Strip inline HTML and decode the entities engines emit in titles/snippets. */
function cleanText(text) {
  return decodeEntities(text.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Register the provider with the web seam.
 * @param ctx - plugin context (the `web` seam is injected).
 * @param config - entry config; see `endpointsOf`.
 */
export function apply(ctx, config = {}) {
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider({ endpoints: endpointsOf(config) }));
}
