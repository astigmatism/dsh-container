// dsh-follow-up-suggestions: dependency-free selection, prompt, and parsing
// logic shared by the host half and the repository tests.

const USER_WINDOW = 3
const MAX_USER_CHARS = 1500
const MAX_EARLIER_ANSWER_CHARS = 400
const MAX_LATEST_ANSWER_CHARS = 2400
const MAX_SUGGESTION_CHARS = 200

/** Concatenated text blocks of one durable message, or ''. */
export function messageText(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function clipHead(text, max) {
  return text.length <= max ? text : text.slice(0, max).trimEnd() + ' …'
}

function clipTail(text, max) {
  // Offers and questions usually close an answer, so keep its end.
  return text.length <= max ? text : '… ' + text.slice(text.length - max).trimStart()
}

/**
 * Select the excerpt suggestions are grounded in.
 * @param events - complete Session log.
 * @param turn - the Turn whose completion the browser is showing.
 * @returns status 'ready' with ordered user/assistant entries, or the reason none apply.
 */
export function conversationExcerpt(events, turn) {
  let end
  let laterTurn = false
  for (const event of events) {
    if (event.type === 'turn/end' && event.data?.turn === turn) end = event
    else if (event.type === 'turn/start' && typeof event.data?.turn === 'number' && event.data.turn > turn) laterTurn = true
  }
  if (laterTurn) return { status: 'not-latest' }
  if (end === undefined) return { status: 'not-completed' }
  if (end.data.reason?.kind !== 'completed') return { status: 'not-completed' }

  // One user entry per human prompt; one assistant entry per Turn (its last text).
  const exchanges = []
  let current
  for (const event of events) {
    if (event.seq > end.seq) break
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      const text = messageText(event.data)
      if (text === '') continue
      current = { user: [text], answer: '', turn: undefined }
      exchanges.push(current)
    } else if (event.type === 'assistant/message' && current !== undefined) {
      const text = messageText(event.data?.message)
      if (text === '') continue
      current.answer = text
      current.turn = event.data.turn
    }
  }
  const relevant = exchanges.slice(-USER_WINDOW)
  if (relevant.length === 0 || relevant.at(-1).answer === '') return { status: 'empty' }
  const entries = []
  relevant.forEach((exchange, index) => {
    const latest = index === relevant.length - 1
    for (const text of exchange.user) entries.push({ role: 'user', text: clipHead(text, MAX_USER_CHARS) })
    if (exchange.answer !== '') {
      entries.push({
        role: 'assistant',
        text: latest ? clipTail(exchange.answer, MAX_LATEST_ANSWER_CHARS) : clipHead(exchange.answer, MAX_EARLIER_ANSWER_CHARS),
      })
    }
  })
  return { status: 'ready', entries, closingSeq: end.seq }
}

/** System and user prompt for one request. */
export function buildPrompt(entries, previous, count) {
  const system = [
    'You suggest follow-up prompts for a person working with an AI assistant.',
    `Write ${count} short prompts this person is likely to send next, in their own voice, addressed to the assistant.`,
    "Ground every suggestion in the person's goal and the assistant's latest answer.",
    'If the latest answer ends with an offer or a question (for example "Want me to…?" or "Should I…?"), make the first suggestion accept or answer it.',
    'Make each suggestion specific and actionable, at most 15 words, and different from the others.',
    'Do not suggest prompts about the assistant itself, this suggestion feature, or the chat system unless the person is discussing them.',
    'Use the language the person writes in.',
    `Do not call tools. Reply with only a JSON array of ${count} plain strings, for example ["First prompt", "Second prompt", "Third prompt"]. No objects, keys, or other text.`,
  ].join('\n')
  const parts = [
    'Conversation excerpt as JSON, oldest first. The final entry is the assistant\'s latest answer:',
    JSON.stringify(entries),
  ]
  if (previous.length > 0) {
    parts.push('Already suggested earlier in this conversation; do not repeat these:', JSON.stringify(previous))
  }
  parts.push(`Return the JSON array of ${count} follow-up prompts now.`)
  return { system, user: parts.join('\n\n') }
}

function cleanItem(value) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/\s+/g, ' ').trim()
  // Strip list markers and wrapping quotes some models add anyway.
  text = text.replace(/^(?:[-*•]|\d+[.)、])\s+/, '').trim()
  if (text.length >= 2 && /^["'“‘「]/.test(text) && /["'”’」]$/.test(text)) text = text.slice(1, -1).trim()
  return text.length > MAX_SUGGESTION_CHARS ? '' : text
}

function unique(items, count) {
  const seen = new Set()
  const result = []
  for (const item of items.map(cleanItem)) {
    const key = item.toLowerCase()
    if (item === '' || seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length === count) break
  }
  return result
}

// A suggestion reads as a sentence; JSON keys such as "prompt" do not.
const looksLikePrompt = (value) => typeof value === 'string' && /\S\s+\S/.test(value.trim())

/** Every JSON string literal in `text`, decoded, in order. */
function stringLiterals(text) {
  const values = []
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    try {
      values.push(JSON.parse(`"${match[1]}"`))
    } catch {
      // Not a valid literal; skip it.
    }
  }
  return values
}

/**
 * Parse model output into at most `count` suggestions. Models usually return
 * the requested string array, but some wrap items in objects, repeat keys, or
 * truncate the array; take the sentence-like string values in order.
 */
export function parseSuggestions(raw, count) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return []
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      // A plain string array is the requested shape. Object items may repeat
      // keys, which JSON.parse collapses, so read their literals instead.
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        const items = unique(parsed, count)
        if (items.length > 0) return items
      }
    } catch {
      // Fall through to literal and line parsing.
    }
  }
  if (start !== -1 || text.startsWith('{')) {
    const items = unique(stringLiterals(text).filter(looksLikePrompt), count)
    if (items.length > 0) return items
  }
  const lines = text.split('\n').filter((line) => !/^\s*(```|[[\]{}])/.test(line))
  return unique(lines, count)
}
