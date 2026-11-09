# dsh-portal-wallpapers

Turns wallpapers **sent from the Service Portal** into this browser's Harness
background. In the portal's Appearance panel every wallpaper tile has a send
button and the gallery has **Send slot to Harness**; this plugin watches the
portal's export queue, imports what arrives, and shows it behind the Harness
without a reload.

It is the receiving half of that feature, and it deliberately does *not* own the
background: the image is written into the
[`dsh-ui-appearance`](https://www.npmjs.com/package/dsh-ui-appearance) plugin's
own storage, so the appearance you already configured (opacity, blur, scrim,
transparency, palette) keeps working, and the Appearance panel remains the place
that owns it.

## Why a queue instead of a download

The appearance plugin keeps the background image in the browser that uploaded it
(IndexedDB) — there is no network endpoint that could receive a wallpaper, and
mixed-content blocking forbids this https page from calling the portal's plain
http API directly. So a send queues the wallpaper in the portal, this plugin's
**host** half reads the queue same-origin, and the browser half imports it.
Nothing has to be open on either side: an entry waits, and the portal drops it
when it is acked, when its wallpaper is deleted, after 7 days, or when 25 newer
sends push it out.

## Behavior

- A wallpaper arrives as the background as soon as it is received (within one
  poll: 30 s in a visible tab, 2 minutes in a hidden one, immediately when the
  tab becomes visible or Settings is opened).
- Received wallpapers stay switchable in **Settings → General → Wallpapers sent
  from the Service Portal**: a strip of previews, the one in use marked, click to
  switch back to an older one. No portal round trip is needed to switch.
- Re-sending a wallpaper you already received does not store it twice: it puts
  that picture back on screen if something else was showing.
- The wallpaper's `imageDark` flag always travels with it, because it decides
  whether the Harness keeps light text. Its sampled **accent** is adopted only
  when **Adopt a wallpaper's colors** is on (off by default); even then only the
  roles you have not chosen yourself are filled in, using the same palette math
  the Appearance plugin applies to an upload.
- Two switches, both per browser: **Wallpapers sent from the Service Portal**
  (master, on by default) and the accent adoption above.
- **Background placement**: a 3×3 grid of anchors — the corners, the edge
  centers, the middle — and two sliders for anywhere between them, so a wallpaper
  can be pinned to the upper left of a wide window instead of having its middle
  cropped by it. Same origin grid, same 0–100 numbers as the portal's Appearance
  panel, kept per wallpaper and per browser; the picker appears below the strip
  for whatever is on screen and edits that one. It is offered for any background,
  including one you uploaded in the Appearance panel — the framing is ours to
  choose, the picture stays theirs.
- A failure says which side failed: a portal that does not answer keeps its
  queue and is retried; a portal without the export endpoints says it may predate
  wallpaper export; unreadable Appearance settings leave the Appearance storage
  untouched and suggest opening that panel once.
- A send hands over the **file**, not the result. Once a wallpaper is stored in
  this browser it is acked, even if it could not be put on screen (unreadable
  Appearance settings, a full Appearance store): it is in the switcher below,
  one click away, and fetching it again from the portal would only fail the same
  way.

## Bounded by construction

The queue is a hand-off, not a store, and this plugin's own storage is capped
too, so a year of sends cannot accumulate:

| What | Bound | Why |
|---|---|---|
| Portal queue | 25 entries, 7 days, acked or deleted entries leave | a Harness that stays off loses old sends rather than hoarding them |
| Received wallpapers | 12 most recent | the list exists to switch between recent pictures |
| Received bytes | 150 MB total, oldest given up first | a run of large originals cannot fill the browser |
| Currently showing | never evicted | settings still point at that image record |
| One import | 64 MB image, 8 MB preview | larger payloads are acked with a "too large" note instead of jamming the queue |
| Placed wallpapers | one entry per wallpaper that is off center, dropped once the wallpaper is gone | the center of the crop is what the appearance plugin does unaided, so it costs nothing |

Storage lives in the browser profile (IndexedDB `dsh-portal-wallpapers` plus a
record the appearance plugin owns, plus `dsh-portal-wallpapers.origins` in
localStorage for the placements), so it is per browser and does not survive a
clean browser profile — which is the same deal as uploading a wallpaper in the
Appearance panel yourself.

## Configuration

The `dsh-container-profile` bundle inserts the entry `portal-wallpapers`:

| Field | Default | Meaning |
|---|---|---|
| `portalBaseURL` | empty | Portal origin, e.g. `http://192.168.1.7/`. Empty resolves `$PORTAL_BASE_URL`, then the host this Harness was served from over plain http. |

The zero-configuration default is right for the home layout where the portal and
the Harness share one host. Point it elsewhere when they do not:

```yaml
- id: portal-wallpapers
  config:
    portalBaseURL: http://192.168.1.9/
```

## Routes

All three sit behind the authenticated `/api` fence, and all three are read-only
proxies over the portal: no wallpaper is stored host-side, and nothing is
written except the ack.

- `GET /api/portal-wallpapers/queue` → always 200: `{ ok: true, source, queued }`,
  or `{ ok: false, code }` with `code` one of `unconfigured`, `bad-portal-url`,
  `unreachable`, `timeout`, `upstream-status`, `bad-upstream`.
- `GET /api/portal-wallpapers/asset?id=<uuid>&kind=thumbnail|image` → the
  portal's preview or original bytes, with the cache headers that describe them;
  `413 too-large`, `404 not-found`.
- `POST /api/portal-wallpapers/ack` `{ ids }` → forwards the ack, which is what
  takes an entry out of the portal's queue.

## The coupling, and where it was checked

The plugin's whole value is that it writes into another plugin's storage, so it
depends on `dsh-ui-appearance` keeping that storage shape: the database
`dsh-ui-appearance` version 2 and its `images` store, a record of `{ data, name }`
under a key of its own format, the `dsh-ui-appearance.settings` section with
`backgroundImage` and `imageDark`, and a `storage` handler that re-reads
localStorage (which is what makes a synthetic event enough). Its accent option
reuses its own palette math, copied rather than imported.

Verified against `dsh-ui-appearance` **0.1.25 and 0.1.28** — identical at every
one of those points. `tests/portal-wallpapers.test.mjs` asserts the constants and
the end-to-end write, so a release that moves the storage will fail there rather
than silently stop showing wallpapers; re-read its
`lib/client.js` against the version in `config/plugins.lock.json` when raising
Appearance.

Placement leans on one further thing about that plugin: its layer
`#dsw-appearance-bg` paints the picture with `background-position: center`
written into its own sheet, with no variable behind it and no setting in front of
it. This plugin adds two rules over the top — `::before` for a wallpaper, `video`
for a clip — that read `--dpw-bg-position` off the document, and they carry
`!important` because that is the only dependable way a sheet you do not own
overrules a sheet you do. The property is written only for a picture that was
actually placed, and it goes on the document element rather than the body, which
this plugin watches instead of writing. A wallpaper nobody placed here therefore
draws exactly as it did before, and if Appearance grows a placement control of its
own that writes an inline style, that one wins on its own terms and these two
rules quietly stop mattering.

## Not covered

Background *videos* stay the appearance plugin's own business — the portal has no
video wallpapers — though the placement rules cover its video layer as well, so a
clip is framed by the same origin as a picture. A send carries the file and its
sampled colors, not the framing it was given in the portal: place it once here and
this browser remembers it. Two tabs of the same browser may both poll — the ack is
idempotent, so the picture arrives once.
