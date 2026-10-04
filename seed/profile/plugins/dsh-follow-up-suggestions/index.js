// dsh-follow-up-suggestions: host half.
//
// Serves POST /api/follow-up-suggestions/generate for the browser half. After
// a Turn completes normally, it asks the model for a few short prompts the user
// is likely to send next, grounded in the last few exchanges. Suggestions are
// never written to the Session log and never enter model-visible history.
//
// Resident providers have one generation slot, so this auxiliary request must
// never delay real work: reasoning is turned off when the route allows it,
// output is capped, and any in-flight generation is aborted as soon as a new
// prompt or Turn starts (in its own Session, or in any Session on the same
// provider), or when the last browser waiting for it goes away.
//
// Design adapted from shaoeric/dsh-suggest (MIT); see LICENSE.
import z from '@deepseek-ai/schemastery'
import { buildPrompt, conversationExcerpt, parseSuggestions } from './suggestions.js'

export const name = 'follow-up-suggestions'
export const inject = ['llm', 'sessions', 'connection', 'settings']

export const ROUTE = '/api/follow-up-suggestions/generate'
// Browser Config forms are process-local on non-loopback pages (any LAN or
// gateway URL), so the on/off preference has its own Host route. Writes land
// in the durable profile patch, exactly like a Settings form write.
export const PREFERENCE_ROUTE = '/api/follow-up-suggestions/preference'
// Profile entry id inserted by the dsh-container-profile bundle.
export const ENTRY_ID = 'follow-up-suggestions'

export const Config = z.object({
  enabled: z.boolean().default(true).volatile()
    .description('Suggest follow-up prompts under the latest completed answer.'),
  count: z.number().step(1).min(1).max(5).default(3)
    .description('Number of suggestions to request.'),
  maxOutputTokens: z.number().step(1).min(64).default(1024)
    .description('Output token cap for one suggestion request.'),
  timeoutMs: z.number().step(1).min(1000).max(600000).default(60000)
    .description('End-to-end deadline for one suggestion request.'),
  provider: z.string()
    .description('Optional provider override; set together with model.'),
  model: z.string()
    .description('Optional model override; set together with provider.'),
})

const MAX_REMEMBERED = 12
const CACHE_LIMIT = 64

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function abortReason(signal) {
  const reason = signal.reason
  return reason instanceof Error && typeof reason.code === 'string' ? reason.code : 'aborted'
}

function abortError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function apply(ctx, config) {
  const enabled = () => config.enabled.get() === true
  const cache = new Map()
  const pending = new Map()
  const remembered = new Map()

  const routeFor = (session) => {
    if (typeof config.provider === 'string' && config.provider !== '' && typeof config.model === 'string' && config.model !== '') {
      return { provider: config.provider, model: config.model }
    }
    const header = session.requestHeader()
    const provider = header?.config?.provider
    const model = header?.config?.model
    return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined
  }

  const reasoningOff = async (route, signal) => {
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      const efforts = info?.reasoning?.efforts
      return Array.isArray(efforts) && efforts.some((effort) => effort?.id === 'off') ? 'off' : undefined
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }
  }

  async function generate(sessionId, route, entries, signal) {
    const started = Date.now()
    const count = config.count
    const previous = remembered.get(sessionId) ?? []
    const prompt = buildPrompt(entries, previous, count)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
    const reasoningEffort = await reasoningOff(route, deadline)
    let text = ''
    const blocks = new Map()
    let finish
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      system: prompt.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
      maxTokens: config.maxOutputTokens,
      signal: deadline,
    })) {
      deadline.throwIfAborted()
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') blocks.set(chunk.index, chunk.block.text)
      else if (chunk?.type === 'finish') finish = chunk.reason
    }
    deadline.throwIfAborted()
    const output = blocks.size > 0 ? [...blocks.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]).join('') : text
    const items = parseSuggestions(output, count)
    const meta = { provider: route.provider, model: route.model, reasoning: reasoningEffort ?? 'default', finish: finish?.kind ?? 'none', ms: Date.now() - started }
    if (items.length === 0) {
      const sample = output.replace(/\s+/g, ' ').trim().slice(0, 160)
      const error = new Error(finish?.failure?.message ?? `no usable suggestions (output: ${sample === '' ? 'empty' : JSON.stringify(sample)})`)
      error.meta = meta
      throw error
    }
    remembered.set(sessionId, [...previous, ...items].slice(-MAX_REMEMBERED))
    return { items, meta }
  }

  function remember(key, items) {
    cache.set(key, items)
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  }

  // One generation per Session Turn, shared by every browser waiting on it.
  function start(key, sessionId, route, entries) {
    const controller = new AbortController()
    const entry = { controller, sessionId, provider: route.provider, waiters: 0 }
    entry.promise = generate(sessionId, route, entries, controller.signal).then(
      ({ items, meta }) => {
        remember(key, items)
        return { ok: true, items, meta }
      },
      (error) => controller.signal.aborted
        ? { ok: false, code: abortReason(controller.signal) }
        : { ok: false, code: 'failed', error: errorText(error), ...(error?.meta === undefined ? {} : { meta: error.meta }) },
    ).finally(() => {
      if (pending.get(key) === entry) pending.delete(key)
    })
    pending.set(key, entry)
    return entry
  }

  async function wait(entry, signal) {
    entry.waiters++
    let left = false
    const leave = () => {
      if (left) return
      left = true
      entry.waiters--
      if (entry.waiters === 0) entry.controller.abort(abortError('cancelled'))
    }
    if (signal.aborted) {
      leave()
      return { ok: false, code: 'cancelled' }
    }
    signal.addEventListener('abort', leave, { once: true })
    try {
      return await entry.promise
    } finally {
      signal.removeEventListener('abort', leave)
      if (!left) {
        left = true
        entry.waiters--
      }
    }
  }

  // New work supersedes suggestions: in the same Session always, and in other
  // Sessions when they share the provider (one generation slot). A Session
  // with no logged route yet (its first Turn) may use any provider, so it
  // supersedes everything; that costs at most a few seconds of retry.
  const supersede = (session) => {
    if (pending.size === 0) return
    const provider = session.requestHeader()?.config?.provider
    for (const entry of pending.values()) {
      if (provider === undefined || entry.sessionId === String(session.id) || entry.provider === provider) {
        entry.controller.abort(abortError('superseded'))
      }
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || (event.type === 'user/message' && event.data?.source?.kind === 'user')) supersede(session)
  })

  async function handle(request) {
    if (!enabled()) return json({ ok: false, code: 'disabled' })
    let body
    try {
      body = await request.json()
    } catch {
      return json({ ok: false, code: 'bad-request' }, 400)
    }
    const sessionId = body?.sessionId
    const turn = body?.turn
    if (typeof sessionId !== 'string' || sessionId === '' || !Number.isInteger(turn) || turn < 0) {
      return json({ ok: false, code: 'bad-request' }, 400)
    }
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return json({ ok: false, code: 'session-unavailable' })
    const key = `${sessionId}#${turn}`
    const cached = cache.get(key)
    if (cached !== undefined) return json({ ok: true, items: cached })
    // Reloads and older Turns only reuse work; generating needs a fresh Turn or a click.
    if (body.cachedOnly === true) {
      const inFlight = pending.get(key)
      return json(inFlight === undefined ? { ok: false, code: 'not-cached' } : await wait(inFlight, request.signal))
    }
    const excerpt = conversationExcerpt(session.snapshotEvents(), turn)
    if (excerpt.status !== 'ready') return json({ ok: false, code: excerpt.status })
    const route = routeFor(session)
    if (route === undefined) return json({ ok: false, code: 'no-route' })
    const entry = pending.get(key) ?? start(key, sessionId, route, excerpt.entries)
    return json(await wait(entry, request.signal))
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handle,
  }), 'follow-up-suggestions: route')

  async function preference(request) {
    if (request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, code: 'bad-request' }, 400)
      }
      if (typeof body?.enabled !== 'boolean') return json({ ok: false, code: 'bad-request' }, 400)
      if (!ctx.settings.writable) return json({ ok: false, code: 'read-only', enabled: enabled() }, 409)
      try {
        await ctx.settings.update(ENTRY_ID, { enabled: body.enabled })
      } catch (error) {
        return json({ ok: false, code: 'failed', error: errorText(error), enabled: enabled() }, 500)
      }
      if (!body.enabled) {
        for (const entry of pending.values()) entry.controller.abort(abortError('disabled'))
      }
      // The volatile value follows the document asynchronously; report the accepted write.
      return json({ ok: true, enabled: body.enabled, writable: true })
    }
    return json({ ok: true, enabled: enabled(), writable: ctx.settings.writable === true })
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: PREFERENCE_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: preference,
  }), 'follow-up-suggestions: preference route')

  ctx.effect(() => () => {
    for (const entry of pending.values()) entry.controller.abort(abortError('cancelled'))
    pending.clear()
  }, 'follow-up-suggestions: in-flight generations')
}
