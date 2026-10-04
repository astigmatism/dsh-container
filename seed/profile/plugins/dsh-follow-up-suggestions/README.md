# dsh-follow-up-suggestions

Suggested follow-up prompts for DeepSeek Harness 0.2, in the spirit of Open
WebUI's follow-ups. After an answer completes, a short list of prompts you
might send next appears beneath it. Click one to send it, or use the pencil to
put it in the composer and edit it first.

Turn it on or off in **Settings → General → Suggest follow-up prompts**. The
choice is saved in the durable profile (`profiles/web/cordis.patch.yml`) and
applies to every browser.

## Behavior

- Suggestions appear only under the latest Turn, and only when it completed
  normally (not after Stop, an error, or an output-limit end). They disappear
  as soon as a new prompt starts. Subagent views don't show them.
- Generation is automatic only for a Turn that finished within the last two
  minutes. After a reload, cached suggestions return. For older Turns, a
  **Suggest follow-ups** button generates them on demand.
- Each set is one short request to the conversation's own provider and model,
  with reasoning turned off when the model offers that, and at most
  `maxOutputTokens` output tokens. The request uses the last three user
  prompts and the closing answer of each of those Turns. Nothing is written to
  the Session log, and suggestions never enter model-visible history.
- Resident providers have one generation slot. An in-flight suggestion request
  is aborted when a new prompt or Turn starts in the same Session, or in
  another Session on the same provider, and when every browser waiting for it
  disconnects, so suggestions never hold up real work.

## Configuration

The `dsh-container-profile` bundle inserts the entry `follow-up-suggestions`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Live switch (the Settings toggle) |
| `count` | `3` | Suggestions per answer (1–5) |
| `maxOutputTokens` | `1024` | Output cap for one request |
| `timeoutMs` | `60000` | End-to-end deadline for one request |
| `provider`, `model` | unset | Route suggestions to a fixed model; set both or neither |

To use a cheaper or faster model than the conversation's, add an override to
the profile patch, for example:

```yaml
- id: follow-up-suggestions
  config:
    provider: amazon-bedrock
    model: us.anthropic.claude-haiku-4-5-20251001-v1:0
```

## Routes

Both routes sit behind the authenticated `/api` fence.

- `POST /api/follow-up-suggestions/generate` `{ sessionId, turn, cachedOnly? }`
  returns `{ ok: true, items }` or `{ ok: false, code }`.
- `GET|POST /api/follow-up-suggestions/preference` reads or writes `{ enabled }`.
  Browser Config forms only persist on loopback pages, so the switch uses this
  Host route instead.

## Credits

Adapted from [shaoeric/dsh-suggest](https://github.com/shaoeric/dsh-suggest)
(MIT), rewritten for the 0.2 slot, settings, and connection APIs.
