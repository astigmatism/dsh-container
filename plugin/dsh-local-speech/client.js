window.__ModuleLoader__.load({
  id: 'dsh-local-speech-input',
  factory: () => {
    const STYLE_ID = 'dsh-local-speech-style'
    const BUTTON_ATTR = 'data-local-speech-button'
    const CONFIG_URL = '/local-stt/config'
    const TRANSCRIBE_URL = '/local-stt/transcriptions'

    let active = null
    let configPromise = null

    function config() {
      if (configPromise === null) {
        configPromise = fetch(CONFIG_URL, { credentials: 'same-origin' }).then(async response => {
          if (!response.ok) throw new Error(`Speech configuration failed (${response.status})`)
          return response.json()
        })
      }
      return configPromise
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        [${BUTTON_ATTR}] {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: 999px;
          color: currentColor;
          cursor: pointer;
          display: inline-flex;
          height: 30px;
          justify-content: center;
          opacity: .72;
          padding: 0;
          width: 30px;
        }
        [${BUTTON_ATTR}]:hover { background: color-mix(in srgb, currentColor 9%, transparent); opacity: 1; }
        [${BUTTON_ATTR}][data-state="recording"] { color: #e23b3b; opacity: 1; animation: dsh-local-speech-pulse 1.25s ease-in-out infinite; }
        [${BUTTON_ATTR}][data-state="working"] { cursor: wait; opacity: .45; }
        [${BUTTON_ATTR}][data-state="error"] { color: #e28b2d; opacity: 1; }
        @keyframes dsh-local-speech-pulse { 50% { transform: scale(.84); opacity: .55; } }
      `
      document.head.appendChild(style)
    }

    function icon() {
      return '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75v-5a3.75 3.75 0 0 0-7.5 0v5A3.75 3.75 0 0 0 12 15.25Zm-2.25-8.75a2.25 2.25 0 0 1 4.5 0v5a2.25 2.25 0 0 1-4.5 0v-5Zm-4.5 4.75a.75.75 0 0 1 1.5 0 5.25 5.25 0 0 0 10.5 0 .75.75 0 0 1 1.5 0 6.76 6.76 0 0 1-6 6.71v2.29h2.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5h2.5v-2.29a6.76 6.76 0 0 1-6-6.71Z"/></svg>'
    }

    function setState(button, state, title) {
      button.dataset.state = state
      button.title = title
      button.setAttribute('aria-label', title)
    }

    function extensionFor(mime) {
      if (mime.includes('ogg')) return 'ogg'
      if (mime.includes('mp4')) return 'm4a'
      if (mime.includes('wav')) return 'wav'
      return 'webm'
    }

    function recorderOptions() {
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/ogg;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ]
      const mimeType = candidates.find(candidate => MediaRecorder.isTypeSupported(candidate))
      return mimeType === undefined ? {} : { mimeType }
    }

    function insertTranscript(textarea, transcript) {
      const clean = transcript.trim()
      if (clean === '') return
      const start = textarea.selectionStart ?? textarea.value.length
      const end = textarea.selectionEnd ?? start
      const before = textarea.value.slice(0, start)
      const after = textarea.value.slice(end)
      const prefix = before !== '' && !/\s$/.test(before) ? ' ' : ''
      const suffix = after !== '' && !/^\s/.test(after) ? ' ' : ''
      const inserted = `${prefix}${clean}${suffix}`
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (valueSetter === undefined) throw new Error('Unable to update the Harness composer')
      valueSetter.call(textarea, before + inserted + after)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
      const caret = before.length + inserted.length
      textarea.focus({ preventScroll: true })
      textarea.setSelectionRange(caret, caret)
    }

    async function transcribe(button, textarea, chunks, mimeType) {
      setState(button, 'working', 'Transcribing speech…')
      try {
        const speech = await config()
        if (!speech.enabled) throw new Error(speech.reason || 'Speech transcription is not configured')
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
        if (blob.size === 0) throw new Error('The microphone recording was empty')
        const body = new FormData()
        body.append('file', blob, `dictation.${extensionFor(blob.type)}`)
        body.append('model', speech.model)
        const response = await fetch(TRANSCRIBE_URL, {
          method: 'POST',
          credentials: 'same-origin',
          body,
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail = payload.error?.message || payload.detail || payload.error || `STT request failed (${response.status})`
          throw new Error(String(detail))
        }
        if (typeof payload.text !== 'string') throw new Error('STT response did not contain text')
        insertTranscript(textarea, payload.text)
        setState(button, 'idle', 'Dictate with local speech-to-text')
      } catch (error) {
        setState(button, 'error', error instanceof Error ? error.message : String(error))
        window.setTimeout(() => setState(button, 'idle', 'Dictate with local speech-to-text'), 5000)
      }
    }

    async function start(button, textarea) {
      if (!window.isSecureContext || navigator.mediaDevices?.getUserMedia === undefined) {
        throw new Error('Microphone access requires the trusted HTTPS address')
      }
      const speech = await config()
      if (!speech.enabled) throw new Error(speech.reason || 'Speech transcription is not configured')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, recorderOptions())
      const chunks = []
      const limit = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop()
      }, Number(speech.maxRecordSeconds || 300) * 1000)

      recorder.addEventListener('dataavailable', event => {
        if (event.data.size > 0) chunks.push(event.data)
      })
      recorder.addEventListener('stop', () => {
        window.clearTimeout(limit)
        for (const track of stream.getTracks()) track.stop()
        if (active?.recorder === recorder) active = null
        void transcribe(button, textarea, chunks, recorder.mimeType)
      }, { once: true })
      recorder.start(250)
      active = { recorder, button }
      setState(button, 'recording', 'Stop recording and transcribe')
    }

    async function toggle(button, textarea) {
      if (active !== null) {
        if (active.recorder.state === 'recording') active.recorder.stop()
        return
      }
      setState(button, 'working', 'Requesting microphone…')
      try {
        await start(button, textarea)
      } catch (error) {
        setState(button, 'error', error instanceof Error ? error.message : String(error))
        window.setTimeout(() => setState(button, 'idle', 'Dictate with local speech-to-text'), 5000)
      }
    }

    function mount(card) {
      if (card.querySelector(`[${BUTTON_ATTR}]`) !== null) return
      const textarea = card.querySelector('textarea')
      const row = card.lastElementChild
      const trailing = row?.lastElementChild
      if (!(textarea instanceof HTMLTextAreaElement) || !(trailing instanceof HTMLElement)) return
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute(BUTTON_ATTR, '')
      button.innerHTML = icon()
      setState(button, 'idle', 'Dictate with local speech-to-text')
      button.addEventListener('mousedown', event => event.preventDefault())
      button.addEventListener('click', () => void toggle(button, textarea))
      trailing.insertBefore(button, trailing.lastElementChild)
    }

    function apply(ctx) {
      installStyle()
      const scan = () => document.querySelectorAll('[data-composer-card]').forEach(mount)
      const observer = new MutationObserver(scan)
      observer.observe(document.documentElement, { childList: true, subtree: true })
      scan()
      const dispose = () => {
        observer.disconnect()
        if (active !== null && active.recorder.state === 'recording') active.recorder.stop()
        document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach(node => node.remove())
        document.getElementById(STYLE_ID)?.remove()
      }
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'local speech input')
    }

    return { apply }
  },
})
