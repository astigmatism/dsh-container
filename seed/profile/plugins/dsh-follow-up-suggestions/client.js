// dsh-follow-up-suggestions: browser half.
//
// Adds a "Suggested follow-ups" list beneath the latest completed answer and an
// on/off switch in Settings > General. Clicking a suggestion sends it; the
// pencil puts it in the composer for editing first. Suggestions are generated
// automatically only for a Turn that just finished; for older Turns (or after
// a reload) a cached result is reused, otherwise a small button asks on demand.
//
// Design adapted from shaoeric/dsh-suggest (MIT); see LICENSE.
window.__ModuleLoader__.load({
  id: 'dsh-follow-up-suggestions',
  factory: (require) => {
    const React = require('react')
    const { Switch, TextShimmer } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    const NAMESPACE = 'follow-up-suggestions'
    const LOCALE = 'followUpSuggestions'
    const ROUTE = '/api/follow-up-suggestions/generate'
    const PREFERENCE_ROUTE = '/api/follow-up-suggestions/preference'
    const STYLE_ID = 'dsh-follow-up-suggestions-style'
    // A Turn that ended longer ago than this was not just watched finishing.
    const FRESH_MS = 120000
    // Outcomes that mean "nothing to show here" rather than an error.
    const QUIET = new Set(['disabled', 'not-latest', 'not-completed', 'empty', 'session-unavailable', 'no-route', 'cancelled'])

    const en = {
      label: 'Suggested follow-ups',
      loading: 'Suggesting follow-ups…',
      suggest: 'Suggest follow-ups',
      retry: 'Retry',
      failed: "Couldn't suggest follow-ups",
      send: 'Send this prompt',
      edit: 'Edit before sending',
      settingTitle: 'Suggest follow-up prompts',
      settingDescription: "After an answer completes, offer a few prompts you might send next. Each suggestion set is one short request to the conversation's model.",
      saveFailed: "Couldn't save this setting",
    }
    const zh = {
      label: '推荐的后续问题',
      loading: '正在生成后续问题…',
      suggest: '推荐后续问题',
      retry: '重试',
      failed: '无法生成后续问题',
      send: '发送此问题',
      edit: '编辑后发送',
      settingTitle: '推荐后续问题',
      settingDescription: '回答完成后,提供几个你可能接着发送的问题。每组推荐会向当前对话的模型发送一次简短请求。',
      saveFailed: '无法保存此设置',
    }

    const CSS = `
.dfus-root{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:4px 0 2px;min-width:0;max-width:100%}
.dfus-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);user-select:none}
.dfus-list{display:flex;flex-direction:column;align-items:stretch;gap:6px;width:100%;min-width:0}
.dfus-chip{position:relative;display:flex;align-items:center;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);transition:border-color .15s ease,background-color .15s ease}
.dfus-chip:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover)}
.dfus-chip:focus-within{border-color:var(--dsw-alias-border-l4)}
.dfus-send{flex:1;min-width:0;border:0;background:transparent;padding:6px 36px 6px 12px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;overflow-wrap:anywhere;border-radius:10px}
.dfus-send:focus-visible,.dfus-edit:focus-visible,.dfus-action:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:1px}
.dfus-edit{position:absolute;top:50%;right:6px;transform:translateY(-50%);width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;transition:opacity .15s ease,color .15s ease,background-color .15s ease}
.dfus-chip:hover .dfus-edit,.dfus-edit:focus-visible{opacity:1}
.dfus-edit:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dfus-edit svg{width:14px;height:14px;display:block}
.dfus-skeleton{height:34px;border-radius:10px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2));animation:dfus-pulse 1.2s ease-in-out infinite}
.dfus-skeleton:nth-child(2){width:86%}.dfus-skeleton:nth-child(3){width:72%}
.dfus-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.dfus-action{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;padding:2px 10px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .15s ease,color .15s ease,background-color .15s ease}
.dfus-action:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover)}
.dfus-error{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dfus-setting{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex}
.dfus-setting-title{font-size:14px;line-height:20px}
.dfus-setting-description{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}
.dfus-setting-error{color:var(--dsw-alias-state-error-primary);margin-top:4px;font-size:12px;line-height:18px}
@keyframes dfus-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.dfus-skeleton{animation:none}}
`

    function installStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    const PENCIL = h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
      h('path', { d: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' }))

    async function requestSuggestions(sessionId, turn, cachedOnly, signal) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, turn, ...(cachedOnly ? { cachedOnly: true } : {}) }),
        signal,
      })
      let body = null
      try { body = await response.json() } catch { body = null }
      if (body === null || typeof body !== 'object') return { ok: false, code: 'failed', error: `HTTP ${response.status}` }
      return body
    }

    // The on/off preference lives on the Host (see index.js): browser Config
    // forms are process-local on non-loopback pages such as the gateway URL.
    function createPreference() {
      const store = createSnapshotStore({ status: 'loading', enabled: false, writable: false, saving: false, failed: false })
      let generation = 0
      const accept = (body) => {
        store.update((draft) => {
          draft.status = 'ready'
          draft.enabled = body.enabled === true
          if (typeof body.writable === 'boolean') draft.writable = body.writable
        })
      }
      const refresh = async () => {
        const mine = ++generation
        try {
          const response = await fetch(PREFERENCE_ROUTE, { method: 'GET', cache: 'no-store' })
          const body = await response.json()
          if (mine !== generation) return
          if (response.ok && body?.ok === true) accept(body)
          else store.update((draft) => { draft.status = 'unavailable' })
        } catch {
          if (mine !== generation) return
          store.update((draft) => { if (draft.status === 'loading') draft.status = 'unavailable' })
        }
      }
      const setEnabled = async (enabled) => {
        const mine = ++generation
        store.update((draft) => {
          draft.saving = true
          draft.failed = false
        })
        let accepted = false
        try {
          const response = await fetch(PREFERENCE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
          })
          const body = await response.json()
          accepted = response.ok && body?.ok === true
          if (accepted && mine === generation) accept(body)
        } catch {
          accepted = false
        }
        store.update((draft) => {
          draft.saving = false
          draft.failed = !accepted
        })
        if (!accepted) await refresh()
      }
      return { store, refresh, setEnabled }
    }

    // Focus the composer that belongs to the same conversation pane.
    function focusComposer(from) {
      for (let node = from; node instanceof HTMLElement; node = node.parentElement) {
        const input = node.querySelector('[data-composer-input], [data-composer-card] textarea')
        if (input instanceof HTMLElement) {
          input.focus()
          return
        }
      }
    }

    function SuggestionsTail(props) {
      const { turn, sessionId, useSession, useChat, inputActions, usePreference, t } = props
      const enabled = usePreference((preference) => preference.status === 'ready' && preference.enabled)
      const busy = useSession((session) => session.running || session.pendingSubmissions.length > 0)
      const subagent = useSession((session) => session.subagent !== null)
      const latest = useChat((chat) => chat.timeline.turnOrder.at(-1) === turn.turn)
      const completed = turn.status === 'closed' && turn.end?.data?.reason?.kind === 'completed'
      const active = enabled && !busy && !subagent && latest && completed && typeof sessionId === 'string'
      const [fresh] = React.useState(() => turn.end !== undefined && Date.now() - turn.end.time < FRESH_MS)
      const [request, setRequest] = React.useState(() => ({ cachedOnly: !fresh, attempt: 0 }))
      const [view, setView] = React.useState(() => ({ phase: fresh ? 'loading' : 'hidden' }))
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        if (!active) return undefined
        const controller = new AbortController()
        setView({ phase: request.cachedOnly ? 'hidden' : 'loading' })
        requestSuggestions(sessionId, turn.turn, request.cachedOnly, controller.signal).then((result) => {
          if (controller.signal.aborted) return
          if (result.ok === true && Array.isArray(result.items) && result.items.length > 0) {
            setView({ phase: 'ready', items: result.items })
          } else if (result.code === 'not-cached' || result.code === 'superseded') {
            setView({ phase: 'idle' })
          } else if (QUIET.has(result.code)) {
            setView({ phase: 'hidden' })
          } else {
            setView({ phase: 'error', error: typeof result.error === 'string' ? result.error : String(result.code ?? '') })
          }
        }, (error) => {
          if (controller.signal.aborted) return
          setView({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
        })
        return () => controller.abort()
      }, [active, sessionId, turn.turn, request])

      if (!active || view.phase === 'hidden') return null

      const generate = () => setRequest((previous) => ({ cachedOnly: false, attempt: previous.attempt + 1 }))
      const send = (text) => {
        inputActions.setDraft(text)
        inputActions.submit()
      }
      const edit = (text) => {
        inputActions.setDraft(text)
        focusComposer(rootRef.current)
      }

      let body
      if (view.phase === 'idle') {
        body = h('button', { type: 'button', className: 'dfus-action', onClick: generate }, t('suggest'))
      } else if (view.phase === 'loading') {
        body = [
          h('span', { key: 'label', className: 'dfus-label' }, h(TextShimmer, { active: true }, t('loading'))),
          h('div', { key: 'list', className: 'dfus-list', 'aria-hidden': 'true' },
            h('div', { className: 'dfus-skeleton' }), h('div', { className: 'dfus-skeleton' }), h('div', { className: 'dfus-skeleton' })),
        ]
      } else if (view.phase === 'error') {
        body = h('div', { className: 'dfus-row' },
          h('span', { className: 'dfus-error', title: view.error }, t('failed')),
          h('button', { type: 'button', className: 'dfus-action', onClick: generate }, t('retry')))
      } else {
        body = [
          h('span', { key: 'label', className: 'dfus-label' }, t('label')),
          h('div', { key: 'list', className: 'dfus-list' }, view.items.map((text, index) => h('div', { className: 'dfus-chip', key: index },
            h('button', { type: 'button', className: 'dfus-send', title: t('send'), onClick: () => send(text) }, text),
            h('button', {
              type: 'button',
              className: 'dfus-edit',
              title: t('edit'),
              'aria-label': `${t('edit')}: ${text}`,
              onClick: (event) => {
                event.stopPropagation()
                edit(text)
              },
            }, PENCIL)))),
        ]
      }
      return h('div', { className: 'dfus-root', ref: rootRef, 'data-follow-up-suggestions': view.phase }, body)
    }

    function SettingRow({ usePreference, setEnabled, refresh, t }) {
      const preference = usePreference((value) => value)
      React.useEffect(() => { void refresh() }, [])
      if (preference.status === 'unavailable') return null
      return h('div', { className: 'dfus-setting', 'data-follow-up-suggestions-setting': '' },
        h('div', null,
          h('div', { className: 'dfus-setting-title' }, t('settingTitle')),
          h('div', { className: 'dfus-setting-description' }, t('settingDescription')),
          preference.failed ? h('div', { className: 'dfus-setting-error', role: 'status' }, t('saveFailed')) : null),
        h(Switch, {
          checked: preference.enabled,
          label: t('settingTitle'),
          disabled: preference.saving || preference.status !== 'ready' || !preference.writable,
          onChange: (next) => { void setEnabled(next) },
        }))
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      installStyle()
      ctx.effect(() => () => document.getElementById(STYLE_ID)?.remove(), 'follow-up suggestions: style')
      ctx.effect(() => ctx.locale.register(LOCALE, { en, zh }), 'follow-up suggestions: locale')
      const preference = createPreference()
      void preference.refresh()
      const onVisible = () => {
        if (document.visibilityState === 'visible') void preference.refresh()
      }
      document.addEventListener('visibilitychange', onVisible)
      ctx.effect(() => () => document.removeEventListener('visibilitychange', onVisible), 'follow-up suggestions: preference refresh')

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: NAMESPACE,
        order: 80,
        locale: LOCALE,
        inject: () => ({ hooks: { preference: preference.store }, setEnabled: preference.setEnabled, refresh: preference.refresh }),
      }, SettingRow))

      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: NAMESPACE,
        order: 100,
        locale: LOCALE,
        inject: () => ({ hooks: { preference: preference.store } }),
      }, SuggestionsTail))
    }

    return { name: 'follow-up-suggestions', inject, apply }
  },
})
