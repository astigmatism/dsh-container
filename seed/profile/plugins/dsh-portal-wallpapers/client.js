// dsh-portal-wallpapers: browser half.
//
// Watches the Service Portal's wallpaper export queue and turns a queued
// wallpaper into this browser's background. It does not keep its own idea of
// "the background": the picture is written into the dsh-ui-appearance plugin's
// own storage (its IndexedDB image store plus its localStorage settings), and
// the plugin is woken with the same event it uses to follow a second tab. The
// received wallpapers stay in this plugin's own store, so switching back to one
// you received last week is instant and needs no round trip.
//
// Why this half cannot read the portal by itself: the page runs on
// https://host:3443 while the portal is plain http://host, which mixed-content
// blocking forbids. Every portal call goes through this plugin's host routes.
window.__ModuleLoader__.load({
  id: 'dsh-portal-wallpapers',
  factory: (require) => {
    const React = require('react')
    const { Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    const NAMESPACE = 'portal-wallpapers'
    const LOCALE = 'settings.portalWallpapers'
    const QUEUE_ROUTE = '/api/portal-wallpapers/queue'
    const ASSET_ROUTE = '/api/portal-wallpapers/asset'
    const ACK_ROUTE = '/api/portal-wallpapers/ack'
    const STYLE_ID = 'dsh-portal-wallpapers-style'
    /** This plugin's own preferences. */
    const PREFS_KEY = 'dsh-portal-wallpapers.settings'
    /** The appearance plugin's storage, which this plugin writes into. */
    const APPEARANCE_DB = 'dsh-ui-appearance'
    const APPEARANCE_DB_VERSION = 2
    const APPEARANCE_IMAGE_STORE = 'images'
    const APPEARANCE_SETTINGS_KEY = 'dsh-ui-appearance.settings'
    /** Received wallpapers, keyed by the queue entry that carried them. */
    const LIBRARY_DB = 'dsh-portal-wallpapers'
    const LIBRARY_STORE = 'images'
    // A wall of wallpapers is as useless as none: the list is there to switch
    // between recent ones. The byte cap stops a run of huge originals from
    // filling the browser, and the wallpaper in use is never evicted out from
    // under the settings that point at it.
    const MAX_ITEMS = 12
    const MAX_TOTAL_BYTES = 150 * 1024 * 1024
    const POLL_VISIBLE_MS = 30000
    const POLL_HIDDEN_MS = 120000
    /** A whole slot should arrive promptly without hammering the portal. */
    const MAX_IMPORTS_PER_POLL = 4

    const en = {
      settingTitle: 'Wallpapers sent from the Service Portal',
      settingDescription: 'A wallpaper you send from the portal’s Appearance panel is queued there and becomes this browser’s background here. Wallpapers you received stay switchable below.',
      accentTitle: 'Adopt a wallpaper’s colors',
      accentDescription: 'Also take the accent — and, where you have not chosen one, the background family — sampled from the wallpaper.',
      checkNow: 'Check now',
      checking: 'Checking the portal…',
      off: 'Off: nothing is fetched from the portal.',
      empty: 'No wallpaper is queued in the portal right now.',
      received: 'Received {name}.',
      switched: 'Showing {name}.',
      waiting: 'Waiting for {count} more wallpaper(s) from the portal.',
      portalAt: 'Portal: {url}',
      // Storage trouble and network trouble get separate sentences, because
      // only one of them is fixed by waiting.
      errStorageLibrary: 'This browser could not open its wallpaper store; private-window tabs block it.',
      errStorageAppearance: 'The Appearance plugin’s stored settings could not be read, so nothing was changed. Open its panel once, then check again.',
      tooLarge: 'Skipped {name}: that file is too large for a browser wallpaper.',
      errUnconfigured: 'No Service Portal address is configured for this Harness.',
      errBadPortalUrl: 'The configured Service Portal address is not usable.',
      errUnreachable: 'The Service Portal did not answer. Nothing is lost: it keeps the queue.',
      errTimeout: 'The Service Portal took too long to answer. It keeps the queue.',
      errUpstreamStatus: 'The Service Portal refused the queue request — it may predate wallpaper export.',
      errNotFound: 'That wallpaper is no longer in the portal.',
      errBadUpstream: 'The portal’s queue answer could not be read.',
      errBadRequest: 'The Harness could not read the portal queue.',
      errNetwork: 'The queue could not be read from the Harness.',
      errUnknown: 'The wallpaper could not be received.',
    }
    const zh = {
      settingTitle: '来自服务门户的壁纸',
      settingDescription: '在服务门户的外观面板中发送的壁纸会先在门户排队,然后成为当前浏览器的背景。已收到的壁纸可在下方切换。',
      accentTitle: '采用壁纸配色',
      accentDescription: '同时采用门户从壁纸中取样出的强调色,以及尚未自行设置时的背景色组。',
      checkNow: '立即检查',
      checking: '正在检查服务门户…',
      off: '已关闭:不会从门户获取内容。',
      empty: '服务门户当前没有排队壁纸。',
      received: '已收到 {name}。',
      switched: '正在显示 {name}。',
      waiting: '仍在等待门户中的 {count} 张壁纸。',
      portalAt: '门户:{url}',
      errStorageLibrary: '浏览器无法打开壁纸存储;无痕窗口会阻止它。',
      errStorageAppearance: '无法读取外观插件的设置,因此未作修改。先打开一次它的面板,再检查。',
      tooLarge: '已跳过 {name}:该文件对浏览器壁纸来说过大。',
      errUnconfigured: '当前 Harness 未配置服务门户地址。',
      errBadPortalUrl: '配置的服务门户地址不可用。',
      errUnreachable: '服务门户没有响应。内容没有丢失,队列仍然保留。',
      errTimeout: '服务门户响应超时。队列仍然保留。',
      errUpstreamStatus: '服务门户拒绝了队列请求 —— 可能其版本尚不支持壁纸导出。',
      errNotFound: '该壁纸已不在门户中。',
      errBadUpstream: '无法读取门户返回的队列信息。',
      errBadRequest: 'Harness 无法读取门户的壁纸队列。',
      errNetwork: '无法从 Harness 读取壁纸队列。',
      errUnknown: '壁纸接收失败。',
    }

    /** Host/portal error codes and library failures, as locale keys. */
    const ERROR_KEYS = {
      unconfigured: 'errUnconfigured',
      'bad-portal-url': 'errBadPortalUrl',
      unreachable: 'errUnreachable',
      timeout: 'errTimeout',
      'upstream-status': 'errUpstreamStatus',
      'not-found': 'errNotFound',
      'bad-upstream': 'errBadUpstream',
      'bad-request': 'errBadRequest',
      'bad-kind': 'errBadRequest',
      'bad-id': 'errBadRequest',
      network: 'errNetwork',
      storageLibrary: 'errStorageLibrary',
      storageAppearance: 'errStorageAppearance',
    }

    const CSS = `
.dpw-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:flex-start;gap:24px;padding:16px 0;display:flex}
.dpw-main{min-width:0;display:flex;flex-direction:column;gap:4px}
.dpw-title{font-size:14px;line-height:20px}
.dpw-description,.dpw-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dpw-status{overflow-wrap:anywhere}
.dpw-sub{margin-top:4px}
.dpw-strip{scrollbar-width:thin;display:flex;gap:6px;margin-top:10px;overflow-x:auto;padding-bottom:2px}
.dpw-thumb{flex:0 0 auto;width:72px;height:44px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;overflow:hidden;position:relative}
.dpw-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dpw-thumb-current{border-color:var(--dsw-alias-border-accent);box-shadow:0 0 0 2px var(--dsw-alias-bg-accent-tertiary)}
.dpw-thumb-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;display:grid;place-items:center;height:100%}
.dpw-actions{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.dpw-check{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;cursor:pointer}
.dpw-check:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpw-check:disabled{opacity:.5;cursor:default}
`

    function installStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function format(template, values) {
      return String(template ?? '').replace(/\{(\w+)\}/g, (all, name) =>
        values !== undefined && name in values ? String(values[name]) : all)
    }

    /* --------------------------------------------------------------------- *
     * Preferences — this browser, like every other Appearance choice.        *
     * --------------------------------------------------------------------- */

    function readPrefs() {
      try {
        const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
        return { enabled: raw?.enabled !== false, adoptAccent: raw?.adoptAccent === true }
      } catch (_corrupt) {
        return { enabled: true, adoptAccent: false }
      }
    }

    function writePrefs(prefs) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      } catch (_quota) {}
    }

    /* -------------------------------------------------------------- *
     * IndexedDB helpers (shared by the plugin's store and the        *
     * appearance plugin's, which it writes into directly).           *
     * -------------------------------------------------------------- */

    function openDb(name, version, stores) {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version)
        request.onupgradeneeded = () => {
          const db = request.result
          // Match the appearance plugin's own upgrade exactly: create what is
          // missing, never touch what is already there.
          for (const store of stores) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'))
      })
    }

    function withDb(name, version, storeName, mode, action) {
      return openDb(name, version, [storeName]).then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const request = action(transaction.objectStore(storeName))
        let result
        request.onsuccess = () => { result = request.result }
        request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'))
        transaction.oncomplete = () => { db.close(); resolve(result) }
        transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb transaction failed'))
      }))
    }

    /* --------------------------------------------------------------------- *
     * The appearance plugin's own storage.                                  *
     *                                                                       *
     * Written, not emulated: the image goes into the plugin's image store   *
     * under its own key format, its settings section is merged rather than  *
     * replaced, and the plugin learns of the change through the same        *
     * `storage` event it uses to follow another tab — its handler re-reads  *
     * localStorage and ignores the event payload, so a synthetic event with *
     * the right key is enough.                                              *
     * --------------------------------------------------------------------- */

    /** The appearance plugin's own key format (time-ordered prefix + random). */
    function newBlobKey() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    function putAppearanceImage(blob, name) {
      const key = newBlobKey()
      return withDb(APPEARANCE_DB, APPEARANCE_DB_VERSION, APPEARANCE_IMAGE_STORE, 'readwrite',
        (store) => store.put({ data: blob, name }, key)).then(() => key)
    }

    /** Never delete a key this plugin did not create. */
    function deleteAppearanceImage(key, ownKeys) {
      if (typeof key !== 'string' || key === '' || ownKeys.has(key) !== true) return Promise.resolve()
      return withDb(APPEARANCE_DB, APPEARANCE_DB_VERSION, APPEARANCE_IMAGE_STORE, 'readwrite',
        (store) => store.delete(key)).then(() => ownKeys.delete(key), () => undefined)
    }

    /**
     * The stored settings section. `undefined` means "do not write": the
     * appearance plugin falls back to its defaults on unreadable data, and
     * silently resetting somebody's theme to buy a wallpaper is a bad trade.
     */
    function readAppearanceSettings() {
      let raw
      try {
        raw = localStorage.getItem(APPEARANCE_SETTINGS_KEY)
      } catch (_blocked) {
        return undefined
      }
      if (raw === null) return {}
      try {
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch (_corrupt) {}
      return undefined
    }

    function writeAppearanceSettings(settings) {
      localStorage.setItem(APPEARANCE_SETTINGS_KEY, JSON.stringify(settings))
      try {
        window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_SETTINGS_KEY }))
      } catch (_unsupported) {}
    }

    /** Which image record the background is showing right now, if any. */
    function currentAppearanceImage() {
      const settings = readAppearanceSettings()
      return settings === undefined ? '' : String(settings.backgroundImage ?? '')
    }

    /* The palette the appearance plugin derives when you upload a wallpaper in
       its own panel: the accent plus a background family sharing its hue, used
       only for roles the user has not chosen. Same math, same rounding. */
    function hexToRgb(hex) {
      return [
        Number.parseInt(hex.slice(1, 3), 16) / 255,
        Number.parseInt(hex.slice(3, 5), 16) / 255,
        Number.parseInt(hex.slice(5, 7), 16) / 255,
      ]
    }

    function rgbToHsl(r, g, b) {
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const lightness = (max + min) / 2
      let hue = 0
      let saturation = 0
      if (max !== min) {
        const delta = max - min
        saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
        if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6
        else if (max === g) hue = ((b - r) / delta + 2) / 6
        else hue = ((r - g) / delta + 4) / 6
      }
      return [hue, saturation, lightness]
    }

    function hslToHex(hue0, s, l) {
      const hue = (hue0 - Math.floor(hue0)) * 6
      const c = (1 - Math.abs(2 * l - 1)) * s
      const x = c * (1 - Math.abs((hue % 2) - 1))
      const m = l - c / 2
      let rgb
      if (hue < 1) rgb = [c, x, 0]
      else if (hue < 2) rgb = [x, c, 0]
      else if (hue < 3) rgb = [0, c, x]
      else if (hue < 4) rgb = [0, x, c]
      else if (hue < 5) rgb = [c, 0, x]
      else rgb = [c, 0, 0]
      const toHex = (value) => Math.round((value + m) * 255).toString(16).padStart(2, '0')
      return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`
    }

    function derivePalette(accentHex, isDark) {
      const [hue, s] = rgbToHsl(...hexToRgb(accentHex))
      const hex = (saturation, lightness) => hslToHex(hue, saturation, lightness)
      if (isDark) {
        return { background: hex(s * 0.35, 0.1), panel: hex(s * 0.35, 0.16), input: hex(s * 0.35, 0.21), border: hex(s * 0.25, 0.34) }
      }
      return { background: hex(s * 0.15, 0.98), panel: hex(s * 0.2, 0.94), input: '#ffffff', border: hex(s * 0.2, 0.88) }
    }

    const HEX = /^#[0-9a-f]{6}$/i

    /**
     * Make one stored record this browser's background, optionally adopting the
     * wallpaper's sampled colors. Replaces the image the settings pointed at
     * before, and drops the previous image only when this plugin stored it.
     * @returns {ok: true, appearanceKey} or {ok: false, error}.
     */
    async function applyRecord(record, prefs, ownKeys) {
      const settings = readAppearanceSettings()
      if (settings === undefined) return { ok: false, error: 'storageAppearance' }
      const previous = String(settings.backgroundImage ?? '')
      let key
      try {
        key = await putAppearanceImage(record.image, record.name)
      } catch (_blocked) {
        return { ok: false, error: 'storageAppearance' }
      }
      settings.backgroundImage = key
      settings.imageDark = record.imageDark === true
      const accent = String(record.accent ?? '').toLowerCase()
      if (prefs.adoptAccent === true && HEX.test(accent)) {
        const mode = record.imageDark === true ? 'dark' : 'light'
        const theme = settings[mode] !== null && typeof settings[mode] === 'object' ? { ...settings[mode] } : {}
        settings.accent = accent
        theme.accent = accent
        for (const [role, hex] of Object.entries(derivePalette(accent, record.imageDark === true))) {
          // A role the user picked themselves stays theirs.
          if ((theme[role] ?? settings[role] ?? '') === '') theme[role] = hex
        }
        theme.preset = 'custom'
        settings[mode] = theme
        settings.preset = 'custom'
      }
      try {
        writeAppearanceSettings(settings)
      } catch (_quota) {
        await deleteAppearanceImage(key, new Set([key]))
        return { ok: false, error: 'storageAppearance' }
      }
      ownKeys.add(key)
      await deleteAppearanceImage(previous, ownKeys)
      return { ok: true, appearanceKey: key }
    }

    /* -------------------------------------------------------------- *
     * The received-wallpaper library: this plugin's own storage.      *
     * -------------------------------------------------------------- */

    function libraryAll() {
      return withDb(LIBRARY_DB, 1, LIBRARY_STORE, 'readonly', (store) => store.getAll())
    }

    function libraryPut(record) {
      return withDb(LIBRARY_DB, 1, LIBRARY_STORE, 'readwrite', (store) => store.put(record, record.key))
    }

    const recordBytes = (record) => Number(record?.image?.size ?? 0) + Number(record?.thumb?.size ?? 0)

    /**
     * Keep the list switchable and bounded: newest first, the wallpaper on
     * screen never evicted, and the byte budget respected before the count is.
     */
    async function trimLibrary(freshKey, ownKeys) {
      const records = await libraryAll()
      const ordered = records.slice().sort((a, b) => Number(b.savedAt) - Number(a.savedAt))
      const showing = currentAppearanceImage()
      const kept = []
      let bytes = 0
      for (const record of ordered) {
        const mustKeep = kept.length === 0
          || record.key === freshKey
          || (record.appearanceKey !== '' && record.appearanceKey === showing)
        if (mustKeep || (kept.length < MAX_ITEMS && bytes + recordBytes(record) <= MAX_TOTAL_BYTES)) {
          kept.push(record)
          bytes += recordBytes(record)
          continue
        }
        await withDb(LIBRARY_DB, 1, LIBRARY_STORE, 'readwrite', (store) => store.delete(record.key))
        await deleteAppearanceImage(record.appearanceKey, ownKeys)
      }
      return kept
    }

    /* -------------------------------------------------------------- *
     * One poll of the portal queue.                                   *
     * -------------------------------------------------------------- */

    function nameFor(entry) {
      const slot = typeof entry.slotName === 'string' && entry.slotName !== ''
        ? entry.slotName
        : `Slot ${(Number.isFinite(entry.slotNumber) ? entry.slotNumber : 0) + 1}`
      const position = Number.isFinite(entry.position) ? ` ${entry.position + 1}` : ''
      return `${slot}${position}`
    }

    /** Fetch one portal payload as a Blob; 'too-large'/'not-found' as results. */
    async function fetchAsset(kind, id) {
      const response = await fetch(`${ASSET_ROUTE}?kind=${kind}&id=${encodeURIComponent(id)}`)
      if (response.ok) return await response.blob()
      const body = await response.json().catch(() => null)
      const code = body !== null && typeof body.code === 'string' ? body.code : 'network'
      if (code === 'too-large' || code === 'not-found') return { code }
      throw Object.assign(new Error(code), { code })
    }

    /**
     * Import one queued wallpaper. The full-size picture is what becomes the
     * background; the small preview only feeds the switcher, so losing it costs
     * a thumbnail and nothing else.
     */
    async function importEntry(entry, prefs, ownKeys) {
      const image = await fetchAsset('image', entry.id)
      if (image?.code === 'too-large') return { skipped: nameFor(entry) }
      if (image?.code === 'not-found') return { dropped: true }
      const thumbnail = await fetchAsset('thumbnail', entry.id).catch(() => null)
      const record = {
        key: `${entry.id}:${Number(entry.queuedAt)}`,
        id: entry.id,
        queuedAt: Number(entry.queuedAt),
        name: nameFor(entry),
        slotId: entry.slotId,
        position: entry.position,
        imageDark: entry.imageDark === true,
        accent: typeof entry.accent === 'string' ? entry.accent : '',
        type: typeof entry.type === 'string' ? entry.type : '',
        savedAt: Date.now(),
        appliedAt: 0,
        appearanceKey: '',
        image,
        thumb: thumbnail instanceof Blob ? thumbnail : null,
      }
      const applied = await applyRecord(record, prefs, ownKeys)
      if (applied.ok === true) {
        record.appliedAt = Date.now()
        record.appearanceKey = applied.appearanceKey
      }
      // Stored either way: an apply failure (unreadable Appearance settings)
      // must not bounce the entry back into a queue it was already taken from,
      // and the row can still offer the picture for a later click.
      await libraryPut(record)
      return { record, applied }
    }

    /**
     * One pass over the queue. All of it is recoverable: the portal keeps an
     * entry until it is acked, so a crash or a closed tab means the next poll
     * starts again, and the portal's own caps mean a Harness that stays off
     * simply loses old sends instead of accumulating them.
     */
    async function poll(prefs, state, ownKeys) {
      let body
      try {
        const response = await fetch(QUEUE_ROUTE, { cache: 'no-store' })
        body = await response.json().catch(() => null)
        if (response.ok !== true || body?.ok !== true) throw Object.assign(new Error('queue'), { code: codeOf(body) })
      } catch (error) {
        state.update((draft) => {
          draft.busy = false
          draft.error = codeOf(error)
        })
        return
      }
      const source = typeof body.source === 'string' ? body.source : ''
      const queued = Array.isArray(body.queued) ? body.queued : []
      let records
      try {
        records = await libraryAll()
      } catch (_blocked) {
        state.update((draft) => { draft.busy = false; draft.error = 'storageLibrary'; draft.source = source })
        return
      }
      for (const record of records) if (record.appearanceKey) ownKeys.add(record.appearanceKey)
      const known = new Map(records.map((record) => [record.id, record]))
      const acked = []
      let notice = null
      let imports = 0
      for (const entry of queued) {
        if (typeof entry?.id !== 'string') continue
        const existing = known.get(entry.id)
        if (existing !== undefined && Number(existing.queuedAt) >= Number(entry.queuedAt)) {
          // Already imported. A re-send means "put this one back", not "store
          // it twice", so it is re-applied only when it is not on screen.
          if (existing.appearanceKey !== '' && existing.appearanceKey !== currentAppearanceImage()) {
            const applied = await applyRecord(existing, prefs, ownKeys)
            if (applied.ok === true) {
              existing.appearanceKey = applied.appearanceKey
              existing.appliedAt = Date.now()
              await libraryPut(existing)
              notice = { kind: 'switched', name: existing.name }
            } else {
              notice = { kind: 'error', error: applied.error }
            }
          }
          acked.push(entry.id)
          continue
        }
        if (imports >= MAX_IMPORTS_PER_POLL) continue
        imports += 1
        let result
        try {
          result = await importEntry(entry, prefs, ownKeys)
        } catch (error) {
          notice = { kind: 'error', error: codeOf(error) }
          continue
        }
        if (result.dropped === true) {
          notice = { kind: 'error', error: 'not-found' }
          acked.push(entry.id)
          continue
        }
        if (result.skipped !== undefined) {
          notice = { kind: 'tooLarge', name: result.skipped }
          // Consumed, not retried: it will never fit, and a queue that never
          // drains holds up everything sent after it.
          acked.push(entry.id)
          continue
        }
        records = await trimLibrary(result.record.key, ownKeys)
        if (result.applied.ok === true) notice = { kind: 'received', name: result.record.name }
        else notice = { kind: 'error', error: result.applied.error }
        acked.push(entry.id)
      }
      if (acked.length > 0) {
        await fetch(ACK_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: acked }),
        }).catch(() => undefined)
      }
      const remaining = queued.filter((entry) => acked.indexOf(entry.id) < 0).length
      state.update((draft) => {
        draft.busy = false
        draft.source = source
        draft.queued = remaining
        draft.records = reuse(draft.records, records)
        draft.checkedAt = Date.now()
        if (notice !== null) {
          draft.notice = notice
          draft.error = notice.kind === 'error' ? notice.error : ''
        }
      })
    }

    /** Portal/transport failures arrive as codes of different shapes. */
    function codeOf(value) {
      if (value === null || typeof value !== 'object') return 'network'
      if (typeof value.code === 'string' && ERROR_KEYS[value.code] !== undefined) return value.code
      return 'network'
    }

    /**
     * The rows outlive the settings row — this list lives in the plugin's store
     * so a poll that changed nothing is a no-op — so it carries metadata and the
     * thumbnail itself, and never a blob URL. A URL belongs to whatever is
     * showing the picture: one minted during a visit that has since been closed
     * was revoked on the way out, and an <img> holding it draws a broken image.
     * See Thumb, which owns that lifetime.
     */
    function reuse(previous, records) {
      const sorted = records.slice().sort((a, b) => Number(b.savedAt) - Number(a.savedAt))
      const keys = sorted.map((record) => record.key).join('\n')
      if (previous.length === sorted.length && previous.map((row) => row.key).join('\n') === keys) return previous
      return sorted.map((record) => ({
        key: record.key,
        name: record.name,
        appearanceKey: String(record.appearanceKey ?? ''),
        thumb: record.thumb instanceof Blob ? record.thumb : null,
      }))
    }

    /* -------------------------------------------------------------- *
     * Settings row                                                    *
     * -------------------------------------------------------------- */

    function statusMessage(state, t) {
      if (state.error !== '') {
        const key = ERROR_KEYS[state.error]
        return key === undefined ? t('errUnknown') : t(key)
      }
      if (state.notice.kind === 'received') return format(t('received'), { name: state.notice.name })
      if (state.notice.kind === 'switched') return format(t('switched'), { name: state.notice.name })
      if (state.notice.kind === 'tooLarge') return format(t('tooLarge'), { name: state.notice.name })
      if (state.busy) return t('checking')
      if (!state.enabled) return t('off')
      if (state.queued > 0) return format(t('waiting'), { count: state.queued })
      if (state.checkedAt > 0) return t('empty')
      return ''
    }

    /**
     * One preview of the switcher. Its object URL exists exactly as long as this
     * component is mounted: minted when the picture is put on screen, revoked
     * when it is taken off — including when the settings row as a whole goes
     * away because Settings was closed. So every visit mints fresh ones, and
     * releasing them is what keeps a reopened Settings panel from pointing at
     * blobs that are already gone.
     */
    function Thumb({ blob }) {
      const [url, setUrl] = React.useState('')
      React.useEffect(() => {
        if (blob === null) {
          setUrl('')
          return undefined
        }
        const created = URL.createObjectURL(blob)
        setUrl(created)
        return () => URL.revokeObjectURL(created)
      }, [blob])
      return url === ''
        ? h('span', { className: 'dpw-thumb-empty' }, '·')
        : h('img', { src: url, alt: '', loading: 'lazy' })
    }

    function Row({ useState, usePrefs, setPref, check, show, t }) {
      const state = useState((value) => value)
      const prefs = usePrefs((value) => value)
      React.useEffect(() => { void check() }, [])
      const showing = currentAppearanceImage()
      const message = statusMessage(state, t)
      return h('div', { className: 'dpw-row', 'data-portal-wallpapers-setting': '' },
        h('div', { className: 'dpw-main' },
          h('div', { className: 'dpw-title' }, t('settingTitle')),
          h('div', { className: 'dpw-description' }, t('settingDescription')),
          message === '' ? null : h('div', { className: 'dpw-status', role: 'status' }, message),
          state.source === '' ? null : h('div', { className: 'dpw-description' }, format(t('portalAt'), { url: state.source })),
          state.records.length === 0 ? null : h('div', { className: 'dpw-strip', role: 'group', 'aria-label': t('settingTitle') },
            state.records.map((record) => {
              const current = record.appearanceKey !== '' && record.appearanceKey === showing
              return h('button', {
                key: record.key,
                type: 'button',
                className: current ? 'dpw-thumb dpw-thumb-current' : 'dpw-thumb',
                title: record.name,
                'aria-current': current ? 'true' : undefined,
                onClick: () => void show(record.key),
              }, h(Thumb, { blob: record.thumb }))
            }))),
        h('div', { className: 'dpw-actions' },
          h(Switch, { checked: prefs.enabled, label: t('settingTitle'), onChange: (next) => void setPref('enabled', next) }),
          h('div', { className: 'dpw-sub' }, h(Switch, {
            checked: prefs.adoptAccent,
            label: t('accentTitle'),
            title: t('accentDescription'),
            onChange: (next) => void setPref('adoptAccent', next),
          })),
          h('button', { type: 'button', className: 'dpw-check', disabled: state.busy, onClick: () => void check() }, t('checkNow'))))
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      installStyle()
      ctx.effect(() => () => document.getElementById(STYLE_ID)?.remove(), 'portal wallpapers: style')
      ctx.effect(() => ctx.locale.register(LOCALE, { en, zh }), 'portal wallpapers: locale')

      const prefs = createSnapshotStore(readPrefs())
      const state = createSnapshotStore({
        busy: false,
        enabled: readPrefs().enabled,
        error: '',
        source: '',
        queued: 0,
        records: [],
        checkedAt: 0,
        notice: { kind: 'none' },
      })
      /** Appearance images this plugin created — the only ones it may delete. */
      const ownKeys = new Set()

      let timer = 0
      let stopped = false
      const schedule = () => {
        clearTimeout(timer)
        if (stopped) return
        const delay = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS
        timer = setTimeout(() => void run(), delay)
      }
      const run = async () => {
        schedule()
        const current = prefs.getSnapshot()
        state.update((draft) => { draft.enabled = current.enabled })
        if (stopped || current.enabled !== true) return
        if (state.getSnapshot().busy) return
        state.update((draft) => { draft.busy = true; draft.error = ''; draft.notice = { kind: 'none' } })
        try {
          await poll(current, state, ownKeys)
        } catch (_failed) {
          state.update((draft) => { draft.busy = false })
        }
      }

      const setPref = async (field, value) => {
        const next = { ...prefs.getSnapshot(), [field]: value }
        prefs.update((draft) => { Object.assign(draft, next) })
        writePrefs(next)
        state.update((draft) => { draft.enabled = next.enabled })
        if (field === 'enabled' && value === true) await run()
      }

      const check = async () => { await run() }

      /** Switch to a wallpaper received earlier, with no portal round trip. */
      const show = async (key) => {
        let records
        try {
          records = await libraryAll()
        } catch (_blocked) {
          state.update((draft) => { draft.error = 'storageLibrary' })
          return
        }
        const record = records.find((row) => row.key === key)
        if (record === undefined) return
        for (const row of records) if (row.appearanceKey) ownKeys.add(row.appearanceKey)
        const applied = await applyRecord(record, prefs.getSnapshot(), ownKeys)
        if (applied.ok !== true) {
          state.update((draft) => { draft.error = applied.error })
          return
        }
        record.appearanceKey = applied.appearanceKey
        record.appliedAt = Date.now()
        await libraryPut(record)
        const kept = await trimLibrary(record.key, ownKeys)
        state.update((draft) => {
          draft.records = reuse(draft.records, kept)
          draft.notice = { kind: 'switched', name: record.name }
          draft.error = ''
        })
      }

      const onVisible = () => {
        if (document.visibilityState === 'visible') void run()
        else schedule()
      }
      document.addEventListener('visibilitychange', onVisible)
      ctx.effect(() => () => {
        stopped = true
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisible)
      }, 'portal wallpapers: poll')
      schedule()
      if (readPrefs().enabled) void run()

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: NAMESPACE,
        // Directly below the Appearance row (order 1000) that owns the result.
        order: 1001,
        locale: LOCALE,
        inject: () => ({ hooks: { state, prefs }, setPref, check, show }),
      }, Row))
    }

    return { name: 'portal-wallpapers', inject, apply }
  },
})
