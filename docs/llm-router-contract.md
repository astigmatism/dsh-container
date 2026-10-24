> **Vendored copy — do not edit.** LLM Router client contract, version 1.2, copied from
> llm-router commit `0b1668669214a7c67cbba8008ddc98ffc1e14b72`. Canonical source:
> https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md
> Replace this copy only when the router maintainer announces a new contract version.

# LLM Router client contract

**Version 1.2 · 2026-10-13.** Applies to LLM Router `57e4096` and later, with AI Runtime `e0530db` and later. Version 1.1 added the benchmark exception in §3; version 1.2 records the opt-in `trial` service ID and states what a published configuration really guarantees. No client change is required; see [changes](#15-changes).

This is the contract between the LLM Router and every application that sends it inference requests. It states what the router guarantees and what a client must do to keep working while models, contexts and configurations change underneath it. When another document disagrees with this one, this one wins. Detailed schemas and examples are in the [references](#14-references).

**MUST**, **MUST NOT**, **SHOULD** and **MAY** are used in their usual sense: **SHOULD** means "do this unless you have a specific, documented reason not to".

## 1. Roles

| Party | Owns |
|---|---|
| **AI Runtime** | Which models run, on which GPUs, with what context and slot count. Configurations are switched by hand at any time, without notice to clients. It declares each model's qualified capabilities, including whether it is NSFW. |
| **LLM Router** | One stable API in front of whatever is running. It handles admission and queueing, enforces context and capability limits, translates between protocols, describes what is available (`/v1/router/capabilities`), and pushes changes (`/v1/router/events`). |
| **Client** | Choosing a model for each request, managing conversation history, and reacting to changes and errors as this contract describes. |

The router never does any of these:

- substitute one model for another (a request for an unavailable model fails rather than being redirected);
- download, load or switch models;
- keep conversation state between requests;
- impose a total generation or queue deadline;
- infer anything about a model from its name.

## 2. Connecting

| Client location | OpenAI-compatible base URL | Ollama-compatible base URL |
|---|---|---|
| LAN | `http://192.168.1.4:11434/v1` | `http://192.168.1.4:11434` |
| Container on Rosalina's `local-ai-ollama_default` network | `http://ai-router:11434/v1` | `http://ai-router:11434` |

| Route | Use |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` (alias `/responses`) | OpenAI Responses, stateless |
| `POST /api/chat` | Ollama chat |
| `POST /api/generate` | Ollama text completion; send `think: false` (reasoning is unsupported on this route); prefer `/api/chat` |
| `GET /v1/models`, `GET /v1/models/{id}`, `GET /api/tags`, `POST /api/show`, `GET /api/ps` | Model listings (§4) |
| `GET /v1/router/capabilities`, `GET /v1/router/events` | Deployment state and change events (§4) |

- **Authentication:** none. A client MUST NOT send the router's admin token or any real credential. If an SDK insists on an API key, send the placeholder `local-only`. The router is a trusted-LAN service and MUST NOT be exposed beyond it.
- **Identification:** a client SHOULD send `X-Client-Name: <application-name>` on every request. The router records it in request history and on its dashboard; without it, requests are identified by user agent or IP address.
- **Not provided:** embeddings (400 `UNSUPPORTED_PROFILE_CAPABILITY`) and model management, meaning pull, create, copy, push and delete (`MODEL_MANAGEMENT_DISABLED`).

## 3. Model identity

| ID | Meaning | Stability |
|---|---|---|
| `daytime` | The Daytime service. Present in every **normal** configuration: every configuration that runs a Daytime resident. The AI Runtime may publish a configuration in which no catalog entry declares `daytime`, and then there is none to send. That is not a licence for a client to invent one, or to send something else instead of it. | Stable; make it your default. |
| `nighttime` | The Nighttime service. Present only in **paired** configurations; a solo configuration stops it. | Stable; use it. |
| `trial` | The Strata trial service. Present **only** while a trial configuration is selected, and only under that name: it is opt-in, it is never the configuration the operator falls into, it is never an alias of `daytime` or of any other service, and in every other configuration it is **404 `MODEL_NOT_FOUND`**. | Opt-in. A client sends it only when its operator selected a trial configuration. |
| `local-active` | The reserved compatibility alias: not a service, but "the model this router currently has active" (see **Two kinds of names** below). | Kept for compatibility. Do not adopt it. |
| Canonical IDs, such as `qwen3.8-27b-abliterated-q6_k` | The specific model currently behind a service. | **Can change** with any configuration change. |

- A client MUST send service IDs (`daytime`, `nighttime`, or another service ID the current document advertises). It MUST NOT configure, persist or compare canonical IDs. Responses report the canonical ID in `model`; record it as information only.
- A client SHOULD always send a model. An omitted model selects the default of the **active configuration**, which this contract does not promise is `daytime`: while a trial configuration is selected, an omitted model is answered by the trial. A client that must not be served by a particular model MUST send an ID.
- An unknown ID returns **404 `MODEL_NOT_FOUND`**. This includes a name no entry of the published catalog declares any more, so a service ID is not a promise that outlives the configuration that declared it.
- A known service that the current configuration stops returns **503 `SERVICE_OFFLINE`**. It is then listed in `offline_services` (§4).
- **An opt-in service is never a fallback, in either direction.** A client reaches `trial` only by naming it, when its operator chose a trial configuration, and it steps away from `trial` to a service the operator chose — never the other way round. When `trial` does not answer, the client reports that; continuing on a model nobody selected is not recovery.
- **Exception for benchmarking and evaluation clients.** A client whose results must belong to one exact model MAY pin it for a run. At the start of the run it resolves the service ID to its canonical ID (`ids[service]`), records the canonical ID with the model's `revision`, and sends the canonical ID for the rest of the run. The router then never lets that run reach a different model. While pinned, the client treats each response like this:
  - 404 `MODEL_NOT_FOUND`: the model changed;
  - 503 `SERVICE_OFFLINE`: the model is offline;
  - neither is ever a reason to switch models.

  Such a client still discovers models from the capabilities document (§4). It MUST NOT keep canonical IDs as configuration across runs: new runs start from a service ID.

### Two kinds of names

The router distinguishes sharply between a name that means a service and a name that means "whatever is running", and a client must too. This is exactly how a model the operator did not choose can end up serving a session.

- **Catalog service IDs** — `daytime`, `nighttime`, `trial`, and every other alias the published catalog declares — are governed by this contract. A service ID exists only while some entry of the published catalog declares it: absent means 404 `MODEL_NOT_FOUND`, and a service the configuration deliberately stops means 503 `SERVICE_OFFLINE`. `ids` in the capabilities document (§4) lists every name the router currently accepts and the canonical model behind it, so a client never has to guess which kind it is holding.
- **The compatibility alias** — `local-active`, configured by `ROUTER_MODEL_ALIAS` — is **reserved**, and it is not a service. In the router's single-marker mode it is accepted on `POST /v1/chat/completions`, `/api/chat`, `/api/generate`, `/api/embed`, `/api/show` and `/v1/responses` whenever a model is active, whether or not that model declared the name, and the router always publishes a synthetic `/v1/models` row for it with `alias: true` and `upstream_model` naming whatever answers. In catalog mode it is an ordinary declared alias, and only the configuration's default entry may declare it. In both modes it resolves to one thing: **the model this router has active right now**. It is therefore an alias of the active slot, not an alias of `daytime`, and it follows every switch the operator makes.
- That is the entire reason a client keeps `local-active` — it works without knowing the configuration — and the entire reason not to adopt it: a session that keeps sending it is served by whatever the operator selects next, including a model the operator would not have chosen for it. Send a service ID, and re-read the document when the router says the state changed.
- A catalog entry that declares **no** service alias has no name a conformant client may send: the router lists it with `service` set to its canonical ID (§4) because it will not invent one. Such a model is **not selectable under this contract and MUST NOT be surfaced as a model a person can choose**. When no entry of the active catalog has a service ID at all, the capabilities document warns `CATALOG_HAS_NO_SERVICE_ID` and is not `complete` (§4).

## 4. Knowing what is available

### Capabilities document

`GET /v1/router/capabilities` returns one document describing the whole deployment, with an `ETag` (send `If-None-Match` to get a 304 when nothing has changed). A client MUST read it at startup, and MUST NOT fail to start when the router is unreachable: start degraded and retry. The fields a client relies on:

| Field | Meaning |
|---|---|
| `revision` | Content hash of everything below except load. If `revision` is unchanged, nothing relevant has changed. |
| `router.accepting_requests` | False while the router drains for a configuration switch, or during maintenance. |
| `configuration.id`, `configuration.exclusive` | The AI Runtime configuration, and whether it is solo. |
| `models[]` | Each usable model: `service` (the ID to send), `aliases`, `available`, `slots`, `context_window`, `input_modalities`, `capabilities`, `nsfw`, `capability_score`, and full `metadata`. |
| `offline_services[]` | Services this configuration deliberately stops: `model`, `aliases`, `display_name`, `reason`. |
| `ids` | Every accepted ID → its current canonical model. |
| `complete`, `warnings` | Whether this router trusts the picture it is publishing. See below. |
| `load` (only with `?include=load`) | Per model: `active`, `queued`, `free_slots`. |

Clients MUST ignore unknown fields. `metadata` is identical to the model's `x_ollama_router` object in `/v1/models`. The OpenAI and Ollama listings (`/v1/models`, `/api/tags`) show only models that can be selected right now, so an offline service is absent from them; only the capabilities document says why.

The router never invents a service ID. When the published catalog gives a model no service alias, `service` repeats that model's canonical ID: `service === id` is how a model with **no addressable ID** reads, and under §3 a client MUST NOT offer it as a choice — it may only be reached by a canonical ID, which clients may not configure. When no model of the active catalog has a service ID, the document carries `warnings: ["CATALOG_HAS_NO_SERVICE_ID"]` and `complete: false`: the router is saying out loud that a §3-conformant client has nothing to send in this configuration. Treat that as the runtime's business, report it to your operator, and keep the models you do have addressable in mind. It is a different fact from the runtime's own `deployment_warnings`, which the publisher writes and which the router passes through unchanged.

### Change events

`GET /v1/router/events` is a Server-Sent Events stream.

- **Each connection** starts with the complete document as `event: capabilities` (`id:` is its `revision`), then `event: load`.
- **A new `capabilities` event**, always the complete document, follows every change: immediately for a runtime publication, drain or maintenance change; within about 10 s for a backend health change.
- **`load` events** carry slot occupancy, at most once per second.
- **`: keepalive` comments** arrive every 15 s.

During a switch, a subscriber sees: draining (`accepting_requests: false`), then the new configuration, then `accepting_requests: true`.

A long-running client SHOULD hold one subscription for its lifetime and replace its copy of the document whenever `revision` changes. While disconnected it MUST fall back to polling the capabilities endpoint (every 30 s, with `If-None-Match`). It reconnects with backoff starting at the stream's `retry:` value (3 s), up to 30 s. A connection with no bytes for 60 s, keepalives included, is dead. A short-lived or request-scoped client MAY instead fetch the document before each request.

### NSFW flag and capability score

- **`nsfw`** is `true` for models the runtime declares abliterated (refusals removed), `false` for models it declares not, and `null` if undeclared. Treat `null` as "not known to be NSFW".
- **`capability_score`** is an automatic 0–100 ranking; higher is more capable. It is comparable only between models of this router. It is built from three parts:
  - parameter count, scaled down for heavier quantization;
  - context window;
  - vision, tools and reasoning support.

  Availability, load and speed never change it. It cannot measure answer quality: it can't account for what abliteration costs, or compare a mixture-of-experts model fairly with a dense one.

## 5. Choosing a model

A client chooses the service for **each request** from its current document. It chooses in one of two ways and SHOULD make the choice configurable:

- **By capability:** the most capable `available` model that has the features the request needs, optionally restricted to `nsfw: true`, with or without falling back to any model. Prefer this when a service wants Nighttime *because* it is uncensored. The reference clients implement it as `pick_service(doc, nsfw=True, require=[...], fallback_any=True)`.
- **By name:** a preferred service ID plus an ordered fallback list, for example `nighttime` then `daytime`. The reference clients implement it as `resolve(doc, preferred, fallbacks)`.

Apply these rules whichever way you choose:

| Situation | Client action |
|---|---|
| `router.accepting_requests` is false | **Wait** and retry the same choice later (§7). MUST NOT fall back: every model is draining. |
| Chosen model listed and `available` | Use it. |
| Chosen model offline, unavailable or absent | Use the next candidate that is `available` and supports the request's needs. A client MAY disable fallback; it then reports the service as temporarily unavailable. |
| Nothing usable | Report "temporarily unavailable" and retry later. |
| The preferred model returns | Use it again from the next request. Fallback MUST NOT be sticky. |

- **Feature checks:** before sending, check the target model. Images need `image` in `input_modalities`; tools need `tools` in `capabilities`; reasoning needs `thinking` in `capabilities` and the requested effort in `metadata.reasoning.efforts`. A missing capability makes that model unsuitable for the request; don't send and hope.
- **Opt-in services are never candidates.** A service the operator opts into by configuration — `trial` today — is not in the pool a capability-based choice draws from, and a name-based fallback list never acquires it. It is used by a client whose operator selected the matching configuration, under that name, and never as a way of getting an answer: falling back to a trial the current user never asked for, or away from one to a model that would have been refused, are both wrong. Report it instead.
- **Behavioral differences:** Daytime is not abliterated and may refuse what Nighttime answers. A client that falls back MUST surface a refusal clearly and MUST NOT retry it in a loop.
- **Logging:** a client SHOULD log every change of served model and its reason, and show it where it already shows model status.

Benchmarking and evaluation clients are the exception. A benchmark's identity is its model, so such a client MUST NOT fall back. It treats an offline or unavailable target as "waiting", not as a changed or invalid run.

## 6. Sending requests

- **Streaming:** a client MUST set `stream` explicitly. `/v1/chat/completions` and `/api/chat` **stream when `stream` is omitted**; `/v1/responses` does not.
- **Statelessness:** every request MUST carry the full conversation the model needs. Responses `previous_response_id` and `store: true` are rejected with 400 `STATEFUL_REQUEST_UNSUPPORTED`.
- **Output limits:** output is unrestricted unless the client asks for a limit. To limit it, send a positive integer: `max_tokens` or `max_completion_tokens` (Chat Completions), `max_output_tokens` (Responses), or `options.num_predict` (Ollama, where `-1` means unrestricted). A client MUST NOT send `-1` or `0` on OpenAI routes, and MUST NOT send two conflicting limits. A requested limit is honored exactly, subject to context (§8).
- **Reasoning:** thinking is **on by default**, at the chat template's default effort, with no separate budget. It uses output tokens and time.
  - Choose an effort with `think` (Ollama: `false`, `true`, or an effort), `reasoning_effort` (Chat Completions), or `reasoning.effort` (Responses).
  - The efforts are `off`, `default`, `low`, `medium` and `xhigh`. The aliases `none` → off, `minimal` → low, and `high`/`max` → xhigh are accepted.
  - A client that wants short, fast answers SHOULD turn thinking off explicitly.
- **Tools:** only function tools are supported. The client executes calls and returns results with matching call IDs and the complete preceding history. Provider-executed tools, such as web search, are rejected. Send tools only to models whose `capabilities` include `tools`.
- **Images:** only inline base64 is accepted:
  - Ollama: `messages[].images`;
  - Chat Completions: `image_url` with a `data:image/...;base64,...` URL;
  - Responses: `input_image` with a data URL.

  Remote URLs and file paths are rejected.
- **Structured output:** `response_format` (OpenAI) or `format` (Ollama) is supported. Output that isn't valid JSON ends with an error (§9), never as a success.
- **Sampling:** sampling controls (`temperature`, `top_p`, `top_k`, `seed`, `stop` and similar, top-level or in Ollama `options`) are forwarded or rejected with 400; never silently dropped. Backend controls such as `options.num_ctx` are rejected (`BACKEND_CONTROL_FORBIDDEN`). `seed` accepts 0–4294967295, or -1 for random.

## 7. Capacity, queueing and time

- **Slots:** each model admits `slots` generations at once (usually 1). Aliases of one model share its slots. Extra requests wait in a first-in, first-out queue for that model; Daytime and Nighttime queue independently. A client SHOULD NOT send more concurrent requests to a model than its `slots`. Fallback traffic joins the fallback model's queue, behind its regular users, such as the coding agents on Daytime.
- **Waiting while queued:**
  - Streaming Chat Completions receive `: waiting for inference slot` comments every 15 s.
  - Streaming Ollama chat receives keepalive frames every 15 s: `{"message":{"role":"assistant","content":""},"done":false,"x_router":{"status":"in_progress"},...}`. A client MUST ignore them.
  - Streaming Responses receive `response.created` and `response.in_progress` immediately.
  - Non-streaming requests receive nothing until the result.
- **Deadlines:** there is no queue or total-generation deadline. A client's read timeout MUST allow for queueing plus generation, or the client MUST stream. A backend that stops making progress for 120 s ends the request as an error.
- **Cancellation:** closing the connection cancels the request immediately, including while it is queued. A client SHOULD NOT abandon and resubmit a queued request, because that loses its place.
- **Draining:** during a configuration switch or maintenance, new requests receive 503 `BACKEND_DRAINING` or `MAINTENANCE_MODE`. Requests already accepted, including queued ones, finish normally. A switch usually takes one to two minutes. A client MUST keep waiting and retrying (backoff from 2 s up to 30 s) for at least 10 minutes, then choose its model again: the configuration may have changed.
- **Health checks:** a client SHOULD NOT use `GET /health` to judge model availability; use the capabilities document.

## 8. Context

- **Budget:** each request must fit the target model's per-request `context_window`. The router counts the actual formatted prompt with the model's tokenizer, including the chat template, tools and images. A request is admitted when **formatted input + requested output + `metadata.context_safety_reserve` (1024) ≤ `context_window`**. A request with unrestricted output needs room for at least one generated token.
- **Admission:** a request that doesn't fit, with a requested limit, is rejected with 400 `context_length_exceeded` and the exact arithmetic. Nothing is truncated silently.
- **Recovery for unrestricted requests:** an unrestricted request whose history doesn't fit, or whose generation reaches the end of the context, triggers lossy recovery. The router keeps the system and developer instructions and the latest user turn, fits an excerpt of earlier work, and inserts a visible notice beginning `[Physical context boundary reached.` into the answer. This is **not** lossless memory. `x_router.context_transitions` counts how many times it happened.
- **Managing history:** a client that needs exact history MUST manage it itself: trim or summarize before sending, or send an explicit output limit so overflow is rejected rather than recovered. Tool-call history is shortened only when that is safe; otherwise the request fails with `CONTEXT_RECOVERY_UNAVAILABLE`.
- **Model changes:** a client MUST take limits from the model that will actually serve the request, and MUST recompute its budget when the served model changes. Daytime and Nighttime windows differ, and either may be larger. A client MUST NOT hard-code a context size.

## 9. Results and terminal states

- **Success:** a completed response has a finish reason: `stop`, `tool_calls`, or `length` (the requested output limit was reached). Chat Completions results carry `x_router: {status, stop_reason, record_id, context_transitions}`; Ollama results carry `done_reason`; Responses carry `status` and `incomplete_details`.
- **Incomplete:** a response with `x_router.status: "incomplete"`, Responses `status: "incomplete"`, or Ollama `done_reason: "error"` is **not** a completed answer, even when it contains text. A client MUST NOT treat it as one. In particular:
  - a thinking-only or empty answer fails with `EMPTY_UPSTREAM_RESPONSE`;
  - partial tool arguments fail with `MALFORMED_UPSTREAM_TOOL_ARGUMENTS` and MUST NOT be executed;
  - invalid structured output fails with `MALFORMED_STRUCTURED_OUTPUT`.
- **Errors inside a stream:** once a streaming response has started, including while queued, a later error is delivered **inside the stream** after an HTTP 200:
  - Chat Completions: a `data:` frame with an `error` object (including `code`) and `x_router.status: "incomplete"`, possibly followed by `data: [DONE]`;
  - Ollama: a final line with `"done": true`, `"done_reason": "error"`, a **string** `error` and `x_router.status: "incomplete"`, with the code in `x_router.stop_reason` when known;
  - Responses: `response.failed` or `error` events.

  A streaming client MUST check the final frame, and MUST treat a stream that ends without a normal finish as incomplete.
- **Tracing:** `x-router-generation-id` (a response header) and `x_router.record_id` identify the router's archive record. Include them in bug reports.

## 10. Errors

Every router error carries a machine-readable code:

- **Ollama and Chat Completions:** `{"error": {"code": "…", "message": "…"}}`.
- **Responses, and some Chat Completions errors:** the OpenAI shape `{"error": {"message": "…", "type": "…", "param": "…", "code": "…"}}`.
- **Inside a stream:** see §9.

A client MUST read `error.code` from the object form, and SHOULD tolerate a string `error`. React to the code first, then the HTTP status:

| Code (HTTP status) | Meaning | Client action |
|---|---|---|
| `SERVICE_OFFLINE` (503) | The current configuration deliberately stops this service | Fall back now (§5). Not a failure: don't count it toward retry caps, budgets or circuit breakers. |
| `BACKEND_UNAVAILABLE` (503) | The service's backend isn't healthy | Fall back if possible; otherwise retry with backoff. |
| `MODEL_NOT_FOUND` (404) | The ID isn't offered: no entry of the active configuration declares it (§3) | Fall back if configured, and log a warning: usually a stale or misspelled ID, or a configuration that stopped offering the service. Never fall back from an opt-in service such as `trial` (§5). |
| `BACKEND_DRAINING`, `MAINTENANCE_MODE` (503) | Switch or maintenance in progress | Wait (§7), then choose again. |
| `context_length_exceeded` (400) | The request doesn't fit | Shrink the request, or choose a model with a larger window. Don't retry unchanged. |
| `TOO_MANY_SUBSCRIBERS` (503, events only) | Event-stream limit reached | Poll the capabilities endpoint instead. |
| Other 5xx; 408, 429; network errors and timeouts | Transient | Retry the same service with backoff. |
| Other 4xx | The request is invalid | Fix the request. Don't retry and don't fall back. |

New codes may be added. An unknown 5xx code is transient; an unknown 4xx code is a request error. The reference clients' `classify_error(status, body)` implements this table.

## 11. Change and compatibility

- **Schema versions:** the capabilities document has `schema_version: 1`; model metadata (`x_ollama_router`) has `schema_version: 2`; the capability score carries its own `version`. Fields may be **added** at any time without a version change, and clients MUST ignore fields they don't know. Removing a field or changing its meaning increments the schema version. A client SHOULD warn when it sees a schema version it wasn't written for.
- **Contract versions:** this contract is versioned at the top. A change that requires client changes increments the major version (2, 3, …) and is announced to client maintainers. A minor version (1.1, 1.2, …) only clarifies or adds permissions and never requires client changes, so copies of an earlier minor version stay valid until the next update handoff.
- **Configurations:** models, context windows, slot counts, the canonical IDs behind service IDs, and the existence of `nighttime` all change with configuration and are not part of the contract. Only the rules for discovering them are.
- **Copies in client projects:** every client project keeps this contract in its own repository, so whoever works on that project, person or AI agent, sees it there:
  - **Copy:** keep a verbatim copy at `docs/llm-router-contract.md`. Begin it with this header, then the contract text unchanged:

    ```markdown
    > **Vendored copy — do not edit.** LLM Router client contract, version <N>, copied from
    > llm-router commit `<sha>`. Canonical source:
    > https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md
    > Replace this copy only when the router maintainer announces a new contract version.
    ```

  - **Conformance map:** follow the copy with a section `## How <project> upholds this contract`, or put it in its own file linked from there. It maps each item of the conformance checklist (§13) to the code and tests that meet it, and records any deviation the contract permits, such as fallback disabled under §5.
  - **Agent rule:** add a rule to the project's `AGENTS.md`, or its equivalent: any change that touches router requests, model selection or discovery must uphold `docs/llm-router-contract.md` and keep the conformance map current.
  - **Updates:** when this contract's version changes, the router maintainer sends each project a handoff to replace its copy and review its map.

## 12. Data handling

- **Archiving:** the router archives every generation in full — messages, images, tools, reasoning and output — for up to seven days or 1 GiB, for diagnosis and recovery. Clients MUST NOT send secrets they don't want retained, and SHOULD tell their own users that conversations pass through a logged service.
- **NSFW content:** output from an `nsfw: true` model may be explicit. A client that exposes it to people is responsible for any age, audience or consent controls its context needs.

## 13. Conformance checklist

A client conforms when it meets every item below and has a test for each MUST:

- [ ] Sends service IDs only, or, for a benchmark, a canonical ID pinned per run (§3). Persists no canonical IDs as configuration. Sends `X-Client-Name`.
- [ ] Never falls back to or away from an opt-in service such as `trial`, and never offers a model the document gives no service ID (§3, §5).
- [ ] Reads the capabilities document at startup without failing when the router or a model is unavailable.
- [ ] Long-running: subscribes to `/v1/router/events` and polls while disconnected. Request-scoped: reads the document before each request.
- [ ] Chooses the model per request by capability or by name, with configurable fallback (or, for benchmarks, deliberately none). Returns to the preferred model when it is available again.
- [ ] Waits, without switching, while the router drains or is in maintenance.
- [ ] Classifies errors by `error.code`, as in §10. `SERVICE_OFFLINE` doesn't consume retry or budget allowances.
- [ ] Sets `stream` explicitly; handles queue keepalives and errors inside streams; never treats an incomplete response as complete.
- [ ] Takes context, reserve, slots and features from the serving model, and recomputes them when it changes. Hard-codes no context size.
- [ ] Uses read timeouts that allow for queueing, or streams. Doesn't abandon and resubmit queued requests.
- [ ] Logs model changes and fallbacks, and surfaces refusals from a fallback model instead of retrying them.
- [ ] Keeps a verbatim copy of this contract at `docs/llm-router-contract.md`, a conformance map, and an `AGENTS.md` rule that upholds it (§11).

## 14. References

- [Deployment capabilities and change events](CAPABILITIES.md): the full document schema, event timing and score formula.
- [API reference](API.md), including [llama.cpp sampling controls](API.md#llamacpp-sampling-controls).
- [Model discovery](MODEL_DISCOVERY.md): the `x_ollama_router` metadata fields.
- [Primary integration](PRIMARY_INTEGRATION.md): output policy, queueing, context recovery and archives.
- Reference clients, tested against the router: [Python](clients/router_watch.py) (standard library) and [JavaScript](clients/router-watch.mjs) (Node 18+ and browsers).
- [Client handoff](handoffs/2026-10-07-capability-subscribers.md): how each current project should change to meet this contract.

## 15. Changes

| Version | Change |
|---|---|
| 1.2 | §3: the `daytime` row states the guarantee a real published configuration actually provides; `trial` is added as an opt-in service ID; **Two kinds of names** distinguishes catalog service IDs from the reserved compatibility alias `local-active`; an omitted model is the active configuration's default, which is not necessarily `daytime`. §4 documents what `service` reports for a model the catalog gives no alias, and the `CATALOG_HAS_NO_SERVICE_ID` warning. §5, §10 and §13 follow. A client that sends service IDs and does not adopt `trial` needs no change: the added §13 lines record what §3 and §5 already required. |
| 1.1 | §3: benchmarking and evaluation clients may pin a canonical ID for the duration of a run. §11: minor versions defined. |
| 1 | Initial contract. |

## How DeepSeek Harness upholds this contract

This map covers the router integration in this repository. Fix the map in the
same change as the code whenever router requests, model discovery,
availability, retries or limits change (see [AGENTS.md](../AGENTS.md)). Lines
above this heading are the vendored contract and are never edited.
[`tests/llm-router-contract.test.mjs`](../tests/llm-router-contract.test.mjs)
checks that the copy is verbatim and that this map covers every §13 item.

The map is written against the **1.2** copy. Version 1.1 added the §3 exception
for benchmarking clients that pin a canonical ID for a run; Harness is not a
benchmark client, configures and sends no canonical ID, and claims no use of that
exception. Version 1.2 records the opt-in `trial` service ID, states what a
published configuration really guarantees about `daytime`, separates catalog
service IDs from the reserved `local-active` compatibility alias, and says what
an omitted `model` really selects. Each of those is mapped below where it changes
what this project has to say about its own behavior.

Harness is a long-running client with **one provider route per router**, and a
route's model list is the catalog that router publishes:

| Provider route | Models it configures | Titled by |
| --- | --- | --- |
| `local-ollama` | one row per service ID in `/v1/router/capabilities` — right now `daytime`, `nighttime` and the service published by the second host | the names the router publishes for them |

A route is written from its own router's document, and the only names it is asked
to keep stating are the ones its own settings carry (plus, for the catalog route,
the names of the routes it absorbed). Another router's model is not this route's
business, so it is not offered here as a name that went missing.

Harness keeps no list of services of its own. The three routes earlier releases
configured (`local-ollama`/`daytime`, `local-everyday`/`nighttime`,
`local-trial`/`trial`) each sent one service and were titled `Daytime`,
`Nighttime` and `Trial` — words Harness invented, since the document already
publishes what it calls each name. Those provider IDs survive only as
`RETIRED_ROUTES`, to rewrite persisted selections onto the catalog route; a
service the router starts publishing appears in the picker on the next revision,
and one it stops publishing stays visible only as its recorded state.

Row labels come from the document alone: `metadata.alias_display_names` for the
name being offered, and the model's own `display_name_qualified` or
`display_name` where a publisher left that name untitled. Two names of one model
share the model's title, which is the publisher's own statement that they are the
same model under different names, so the name a person is choosing is appended in
parentheses — the qualifier the router itself would use. ` · NSFW` follows a row
the document declares NSFW. Nothing here is composed by Harness:
`display_name_qualified` is read, never built.

What a model row is *named* follows from the same reading (`routerModelName`):
while a model still answers a service the row carries the published title, and
the service's state lives in its own record; when nothing answers it — the
configuration dropped it, lists it offline, or the router is not answering — the
row names itself and its state, because a remembered title describes a
configuration that may already be gone. The reserved `local-active` alias is
never such a row, even when a route written before service IDs still carries it.
Nothing is published to settings without being read as valid: `metadata` is
validated as a whole before any limit, modality or effort map is taken from it
(§6), and metadata that contradicts its own catalog row — a different
`context_window` or `active_request_limit` — is reported as incomplete rather
than reconciled.

Model selection is **by name**: each session sends the service ID it selected.

**Every request names its model (§3).** Harness always sends `model`. Every
model row on a router route is a service ID, and a session's stored route is
rewritten to a service ID on every request, so a Harness request never omits
`model` and is never answered by the active configuration's default. 1.2 states
plainly that the default is not promised to be `daytime` — while a trial
configuration is selected it is the trial — so the guarantee that a Harness
session is never served by a model nobody named lives in the request: an ID is
always sent. `scripts/verify-router-client-wire.mjs` records every outbound
request and asserts each one carries a non-empty `model`. Names that are not
services are never sent and never offered: a canonical model ID, and the reserved
`local-active` compatibility alias, which §3 says is not a service. A `models[]`
row whose `service` equals its `id` offers nothing, and such a document is held
with a stated reason rather than an invented name.

### Deviation permitted by §5: fallback disabled

Harness never moves a session from one model to another: not from `nighttime` to
`daytime`, not onto an opt-in service, not when the router re-draws its catalog.
The owner fixed this on 2026-10-07 and added the opt-in `trial` service on
2026-10-13 under the same rule. A Harness session is a long
conversation, and quietly
switching models mid-session would change its context window, compaction and
refusal behavior. Instead:

- **When a model can't serve,** the picker shows exactly one state: available,
  offline (with the configuration ID from `offline_services`), unavailable
  (backend unhealthy, ID absent or router unreachable), router switching
  configuration, or incomplete metadata. A service the current configuration
  simply does not declare — no `models` row and no `offline_services` row, which
  1.2 §3 says can now happen to `daytime` as well as to `trial` — is recorded as
  unavailable with reason `not offered by the router`, never as an instruction to
  send something else.
- **Requests to an offline, unavailable or incomplete model** fail at once with
  `MODEL_UNAVAILABLE` and a message that asks the user to switch the session.
  They consume no retries.
- **When it returns,** it is selectable again with no action. Failed prompts are
  never replayed.
- **Every model is independent:** one model's state never blocks updates to
  another, and one model's state never blocks its route. Only a router that
  answers nothing, or publishes an unreadable document, gates the whole route.
- **Nothing selects an opt-in service.** No default, migration, verification,
  restore or fallback path may put a session on one, and a session a human put
  there is never moved off automatically. It is listed and state-checked, never
  sent inference by an automated check. `migrateDefaultSelection` throws rather
  than move a default onto an opt-in service. `OPT_IN_SERVICES` defaults to the
  one name 1.2 §3 gives as the example (`trial`) and is configuration
  (`optInServices`), so a future opt-in name is a settings edit, not a Harness
  release. An opt-in service is provisioned from its own serving metadata and
  never inherits another model's limits, context window or input modalities.
- **A held service is not a failure.** A configuration that does not offer the
  opt-in `trial` service leaves its row present with reason `not offered by the
  router`: the boot migration prints its opt-in notice and exits 0. Exit 22 is
  reserved for invalid local settings; no router configuration — no `trial`, no
  `daytime`, an unreachable router — can produce it.

Because nothing falls back, Harness never sends a request to a model other than
the one selected. It therefore never has a fallback refusal to surface (§5
"Behavioral differences").

### Conformance checklist (§13)

| §13 item | How Harness meets it | Code | Tests |
| --- | --- | --- | --- |
| Sends service IDs only, or, for a benchmark, a canonical ID pinned per run (§3). Persists no canonical IDs as configuration. Sends `X-Client-Name`. | A router route configures the service IDs its router publishes and nothing else; Harness keeps no service list of its own. Startup migration rewrites old IDs in the provider map, the default, compaction `modelPolicies` and every other resident `provider`/`model` pair. Old session routes move to the service ID on their next request, and the adapter accepts old IDs for side calls such as compaction summaries. Canonical IDs appear only in logs. Harness is not a benchmark client and takes no §3 pinning exception: it never resolves a service ID to a canonical ID to send, not even for one run. `X-Client-Name: deepseek-harness/<instance>` is set in the provider `headers` and on every discovery fetch. The instance comes from `HARNESS_CLIENT_INSTANCE`, then `HARNESS_TLS_IP`, then the hostname. Every request also names its model, so no request is answered by the active configuration's default (§3). | `seed/plugins/dsh-router-model-discovery.js` (`ROUTER_PROVIDER`, `RETIRED_ROUTES`, `routerServices`, `planRouterProvider`, `migrateResidentRoute`, `routerClientName`, `agent/request` waterfall), `scripts/migrate-resident-models.mjs` (`routeMigrations`), `scripts/patch-dsh-resident-availability.mjs` (`residentModelId`), `config/settings.yaml`, `seed/profile/managed/cordis.patch.yml`, `compose.yaml` | `tests/router-model-discovery.test.mjs`, `tests/router-provider-remote.test.mjs` (startup migration; MTP3 revision), `tests/resident-settings-migration.test.mjs`, `tests/local-inference-contract.test.mjs`, `scripts/verify-router-client-wire.mjs` (every recorded request names a non-empty `model`; the service ID is what is sent), `scripts/verify-local-model-profiles.mjs`, CI `scripts/verify-router-startup.mjs` |
| Never falls back to or away from an opt-in service such as `trial`, and never offers a model the document gives no service ID (§3, §5). | The `trial` guards are the code 1.2 §3/§5 now describes: `OPT_IN_SERVICES`/`isOptInService` mark the model, and nothing else may select it — no default (`migrateDefaultSelection` throws rather than move onto it), no restore target, no migration, no verification step, no fallback in either direction, and a session a human placed there is left there or fails, with `residentMessage` never suggesting another model. The offered names come from the document but are filtered before they can become a model: `offeredNames` takes `row.service` and its `row.aliases`, and removes the canonical ID, the reserved `local-active` compatibility alias, and a `service` that merely repeats `id` — the row the document gives no service ID for (`aliases: []`, `MODEL_HAS_NO_SERVICE_ID`) is therefore never addressed, never provisioned, and never appears as a selectable model, and a document whose catalog declares no service ID at all (`CATALOG_HAS_NO_SERVICE_ID`, `complete: false`) leaves every model held with a stated reason rather than an invented name. The list of opt-in names is configuration (`optInServices`), with the contract's own example as its default. | `seed/plugins/dsh-router-model-discovery.js` (`OPT_IN_SERVICES`, `isOptInService`, `offeredNames`, `routerServices`, `residentMessage` and its opt-in advice, `migrateDefaultSelection`, `planRouterProvider`), `scripts/verify-router-contract.mjs` (`isOptInService`), `scripts/verify-resident-client.mjs`, `config/settings.yaml` | `tests/router-model-discovery.test.mjs` (opt-in guards; a row with `service === id` and `MODEL_HAS_NO_SERVICE_ID` is never offered; a catalog with only `CATALOG_HAS_NO_SERVICE_ID` rows holds every resident; no migration case selects the trial), `tests/router-provider-remote.test.mjs`, `tests/resident-settings-migration.test.mjs`, `tests/local-inference-contract.test.mjs`, CI `scripts/verify-router-startup.mjs` |
| Reads the capabilities document at startup without failing when the router or a model is unavailable. | The pre-launch migration reads `/v1/router/capabilities` with a 10 s timeout. An unreachable router, an HTTP error, or an offline, unhealthy or incomplete model is recorded per model. Startup exits non-zero only for invalid local settings. If the router is unreachable, stored or seeded settings are kept, every model the route carried is marked unavailable with the router's own reason, and discovery recovers automatically. A configuration that does not offer the opt-in `trial` service is the same kind of recorded state: the route is held with its reason and the update exits 0. What a person *sees* for a recorded state names the model and its state: a name the document attributes no serving model to — a dropped service, an offline service, an unreachable router — loses the model title it remembered, because that title describes a configuration that may no longer exist and reads as a model on offer, and is labelled with the published name and its state; a draining router still attributes a model, so that title stays. The title returns with the model. | `scripts/migrate-resident-models.mjs`, `synchronizeRouterSettings`, `fetchCapabilities`, `planRouterProvider`, `entrypoint.sh` | `tests/resident-settings-migration.test.mjs` (unreachable; HTTP error; invalid local settings), `tests/router-model-discovery.test.mjs` (labelled by its own name while nothing serves it; title kept for a draining route; title restored when the model returns), `tests/router-provider-remote.test.mjs` (unreachable at startup), CI `verify-router-startup.mjs --daytime-only` |
| Long-running: subscribes to `/v1/router/events` and polls while disconnected. Request-scoped: reads the document before each request. | Harness is long-running (the request-scoped form does not apply). One watcher per router holds a subscription for the process lifetime and replaces its copy whenever `revision` changes. Each revision re-synchronizes settings at once, which pushes `settings/document-updated` to open pickers (the earlier 30 s client re-read was removed). While disconnected it polls every 30 s with `If-None-Match`; the revision is the ETag. It reconnects with backoff from the stream's `retry:` (3 s) up to 30 s. 60 s without bytes is a dead stream. `TOO_MANY_SUBSCRIBERS` falls back to polling. | `RouterWatch`, `ResidentDiscovery` in `seed/plugins/dsh-router-model-discovery.js` (adapted from the reference `watchRouter`) | `tests/router-provider-remote.test.mjs` (event stream; `TOO_MANY_SUBSCRIBERS`; discovery service), CI `scripts/verify-resident-availability.mjs` (open picker follows offline → available → offline) |
| Chooses the model per request by capability or by name, with configurable fallback (or, for benchmarks, deliberately none). Returns to the preferred model when it is available again. | By name, with fallback deliberately disabled (deviation above). Every dispatch and every queued request re-checks the selected model's current state. A model that returns is used on the next request. An opt-in service (`trial` by default, `optInServices` in the plugin settings) is never selected, never a default and never a fallback target; only a human selection puts a session on it. The optional `modelPicker.availableOnly` setting (default off, read from the same settings document the resident state persists to: the profile patch, then the pre-0.2 settings file) makes the picker offer only models whose current state is usable: the flag rides the `modelCatalog` result as `availableOnly`, so the server catalog keeps reporting every model and only the picker view changes. With it on, unavailable rows and the rows of a route draining a router switch are not offered, empty provider groups drop out, and an all-hidden list renders one status line instead of a wall of greyed rows. With it off the picker is byte-for-byte the current release. | `scripts/patch-dsh-resident-availability.mjs` (`assertResidentAvailable`, `residentModelBlocked`, `modelPickerAvailableOnly`, picker labels, catalog availability) | `tests/dsh-resident-availability.test.mjs` (setting resolution, catalog transport, picker filter, drain status line, default off, in-place upgrade), `tests/router-provider-remote.test.mjs` (returns with no action), CI `verify-resident-availability.mjs` (no fallback, no replay) |
| Waits, without switching, while the router drains or is in maintenance. | `accepting_requests: false` makes every model "router switching configuration". Such a model is not blocked, and nothing switches. `BACKEND_DRAINING`/`MAINTENANCE_MODE` become `ROUTER_SWITCHING`, which waits on its own retry chain (2 → 30 s, unbounded while switching continues). That chain is separate from the provider's retry budget. Each attempt prepares the call again, so the model is resolved anew; one that is offline in the new configuration then fails clearly. | `residentStatus`; `routerFailureOf` in `scripts/patch-dsh-llm-pi-ai.mjs`; `patchRetry` in `scripts/patch-dsh-resident-availability.mjs` | `tests/router-model-discovery.test.mjs` (draining or maintenance), `tests/router-provider-remote.test.mjs` (router draining), `tests/dsh-resident-availability.test.mjs` (2 → 30 s chain), `scripts/verify-router-client-wire.mjs` |
| Classifies errors by `error.code`, as in §10. `SERVICE_OFFLINE` doesn't consume retry or budget allowances. | The pi-ai transport keeps the router's `error.code` and status from the SDK error, and from in-stream `response.failed`/`error` events. The adapter classifies by code first, then status. `SERVICE_OFFLINE`/`MODEL_NOT_FOUND` become terminal `MODEL_UNAVAILABLE` (no retry), hold the model offline or unavailable, and re-read the document. `BACKEND_UNAVAILABLE` uses the provider's bounded retries (2, 0.5–10 s); three such failures mark the model unavailable. Other 5xx, 408, 429 and network errors are retried; other 4xx fail. Unknown 5xx codes are transient and unknown 4xx codes are request errors. A string `error` is tolerated. | `routerErrorOf`/`routerFailureOf` (`scripts/patch-dsh-llm-pi-ai.mjs`), `router-error-code-v1` (`scripts/patch-unrestricted-policy.mjs`), `ResidentDiscovery.report` | `tests/dsh-llm-pi-ai-patch.test.mjs`, `scripts/verify-router-client-wire.mjs` (every code, HTTP and in-stream, exact body shapes), `tests/dsh-resident-availability.test.mjs` (`MODEL_UNAVAILABLE` never replays, even under always-retry), `tests/router-provider-remote.test.mjs` (`SERVICE_OFFLINE` hold; `BACKEND_UNAVAILABLE` threshold) |
| Sets `stream` explicitly; handles queue keepalives and errors inside streams; never treats an incomplete response as complete. | Every resident request is a Responses stream with `stream: true`. Bytes received while queued, including `: waiting for inference slot` comments, re-arm the idle watchdog. Errors inside the stream are classified as above. A stream without a terminal event, `response.incomplete`, and partial tool JSON are errors, and partial tool JSON is never executed. | `router-stream-activity-v1` (`scripts/patch-unrestricted-policy.mjs`, `routerActivityFetch` in `scripts/patch-dsh-llm-pi-ai.mjs`), `router-incomplete-tool-policy-v1` | `scripts/verify-router-client-wire.mjs` via `tests/router-client-wire.test.mjs` (queued 4× past the idle timeout), `scripts/verify-unrestricted-wire.mjs` (partial tool JSON) |
| Takes context, reserve, slots and features from the serving model, and recomputes them when it changes. Hard-codes no context size. | On every change, an available model's context budget is set to `context_window − metadata.context_safety_reserve`. The same update sets input modalities from `input_modalities` and selectable efforts from `metadata.reasoning`. Harness limits a route as a whole, so its `maxConcurrency` is the `slots` of every *distinct* model the router offers — aliases of one model share its slots (§8), so two names of one model are not two slots — and the router's own per-model queue stays the authority; a route therefore admits no more than the router could serve at once, though it cannot express a per-model share of its own. Compaction thresholds apply to that budget. While a model is not available its last limits are kept, marked `stale` and not acted on. `131072` in `config/settings.yaml` is only a placeholder before the first discovery. Images are refused before sending to a model without `image`, and efforts the model does not offer are refused before sending. | `residentCapabilities`, `planRouterProvider`, `routerServices` | `tests/router-model-discovery.test.mjs` (limits recomputed; stale limits), `tests/router-provider-remote.test.mjs` (one model's limits update while another is unhealthy; MTP3 context change), `scripts/verify-router-contract.mjs` (live) |
| Uses read timeouts that allow for queueing, or streams. Doesn't abandon and resubmit queued requests. | Harness always streams. The router transport has no total or header deadline. The idle timer (`streamIdleTimeoutMs`, 15 min) counts queue keepalives as activity, so a queued request keeps its place. `TIMEOUT` is not a retryable code. | `RouterOpenAI` (`scripts/patch-unrestricted-policy.mjs`), `config/settings.yaml` `retryPolicy` | `scripts/verify-router-client-wire.mjs`, `scripts/verify-unrestricted-wire.mjs` (no SDK deadline; idle expiry only for silent sockets) |
| Logs model changes and fallbacks, and surfaces refusals from a fallback model instead of retrying them. | Every availability transition and served-model change is logged with its reason, for example `router-model-discovery: nighttime: available → offline (flash-next-solo-128k)`. Limit recomputations are logged too. Logs go to the Harness log buffer and the container log, and the state is shown in the picker. There is no fallback, so there are no fallback refusals. | `ResidentDiscovery.logTransition` | `tests/router-provider-remote.test.mjs` (discovery service) |
| Reaches the §2 base URL through one stable name, so a router change is an environment change and not a configuration edit. | The resident routes always use `http://ai-router:11434/v1`; **which** router answers that name is the deployment's `REMOTE_OLLAMA_HOST` setting, re-derived into the running configuration by every update rather than carried forward from the address the deployment was installed with. It accepts a host, a host and port, or a router base URL, plus an optional admin base, and refuses an endpoint the container could not use (TLS, another port, an unresolvable name, its own loopback) before writing or deploying anything. External and managed modes resolve the name inside Docker, and an update strips a stale alias there too. `update-and-restart.sh router` reports the decision and its source file; `set-router` writes it and can require the new router to answer first. During a transition the router a consumer left keeps serving, so a move is reversible by the same command with the previous value. An update does not finish until the running container is inspected and found to resolve the canonical name to the address the setting names, so a mapping that was written but never applied fails the update instead of quietly serving the old router. | `maintenance/router.py` (`plan`, `apply`, `configure`, `probe`), `maintenance/engine.py` (`build_candidate`, `report_router`, `verify_router`), `compose.yaml`, `scripts/update-and-restart.sh` | `tests/router-endpoint.test.py` (moves, moves back, stale mapping never forwarded, accepted and refused spellings, mode and source precedence), `tests/router-endpoint-docker.test.py` (a real container resolves the canonical name to the address the setting names, then follows it to another router and back), `tests/compose-topology.test.sh` |
| Keeps a verbatim copy of this contract at `docs/llm-router-contract.md`, a conformance map, and an `AGENTS.md` rule that upholds it (§11). | This file and the rule in [AGENTS.md](../AGENTS.md). | `docs/llm-router-contract.md`, `AGENTS.md` | `tests/llm-router-contract.test.mjs` |

### Verification never fails on router configuration

Deployment and update verification (`scripts/verify-router-contract.mjs`,
`scripts/verify-resident-client.mjs`, `scripts/verify.sh`) skip an offline,
unavailable, incomplete or switching model with a notice. They still require
its recorded state, label and (when available) limits to match the document.
Rollback verification of a release older than this contract accepts its old
route IDs (`allowLegacyIds`). The same rule covers the shapes 1.2 says a
configuration can take: a service no row declares and no `offline_services` row
names — the opt-in `trial` today, and `daytime` in a catalog that declares no
Daytime resident — is reported and skipped, never a failed verification, and a
document warning `CATALOG_HAS_NO_SERVICE_ID` changes no exit status. What still
fails is a claim Harness makes about itself: a name the router publishes that no
model row carries, a route still titled for a router that publishes a name of its
own, configured limits that no longer match the document, a stale label, the wrong
or a canonical ID configured. The live
verifiers state-check the opt-in route and never select it or send inference
through it: only a non-opt-in resident whose state is `available` is ever picked
up for a selection or inference check, and when none is left the check is logged
as skipped rather than failed, because a router configuration with nothing
servable is the router's business and Harness's own routes are still recorded.

### Interpretations

- **Draining wait.** §7 requires waiting at least 10 minutes. Harness waits as
  long as the router keeps switching (the user can stop the turn), and resolves
  the model again before every attempt.
- **Request-time contradiction.** A `SERVICE_OFFLINE`/`MODEL_NOT_FOUND` answer
  overrides a document that still says available, until a new revision or for
  60 s. Repeated `BACKEND_UNAVAILABLE` after bounded retries does the same.
- **Router unreachable.** When the event stream and a poll both fail, every
  resident model is marked unavailable (dispatch fails fast) until the router
  answers again.
- **Two kinds of names (1.2 §3).** A resident route is matched against what the
  configuration publishes — `row.service`, `row.id`, `row.aliases` — and Harness
  configures only `daytime`, `nighttime` and `trial`. `local-active` is the
  reserved compatibility alias, not a service and not an alias of `daytime`, and
  it means what the router currently has active. Its acceptance depends on the
  mode: in the router's legacy single-marker mode it is accepted without being
  declared, whenever a model is active; in the published-catalog (resident) mode
  only the configuration's default entry may declare it, and any other request
  for it is **404 `MODEL_NOT_FOUND`**. It is never an automatic choice and never a
  default: it appears in no seeded or migrated setting, no default, and no
  candidate list.
- **Pre-contract routers.** A router without `/v1/router/capabilities` (the
  vendored managed-mode router) is read from its `/v1/models` listing, and
  unpublished limits are kept as stored. That router runs the legacy single-marker
  mode, where `local-active` names the one active model and nothing else is
  published; the managed topology always sends that route's traffic to Daytime, so
  a synthesized document reads that active model as the `daytime` service. That is
  this deployment's choice about which service the active slot feeds — not a
  claim that `local-active` is an alias of `daytime`, and not true of a resident
  catalog, where an undeclared `local-active` is a 404. A `trial` row can never be
  reached this way: the synthesis knows only the two services that existed before
  the contract, so an opt-in service is never produced by legacy aliasing. The
  synthesized rows feed the same catalog route as a contract document, and nothing
  else — a pre-contract router simply offers fewer names.
- **A configuration with no `daytime` (1.2 §3).** The `daytime` row is not
  guaranteed by every published configuration. A configured service with no
  `models` row and no `offline_services` row is recorded as unavailable with
  reason `not offered by the router`, the route is held and blocked at dispatch,
  verification prints a notice and continues, and startup still exits 0. Nothing
  fills the gap: no other service, no name the document does not declare, and no
  request without a model. `tests/resident-settings-migration.test.mjs` boots the
  real migration against a synthetic router publishing exactly this shape and
  asserts the held route, the reason, exit 0 and an untouched default;
  `verify-router-startup.mjs --daytime-only` covers the equivalent published
  shape from the other side, where the fixture router stops offering `nighttime`
  and `trial`.
- **The router's new warnings are not the runtime's notes.**
  `CATALOG_HAS_NO_SERVICE_ID` and `MODEL_HAS_NO_SERVICE_ID` are read as the §4
  names they are: the document-level field is advisory (ignored, like any other
  unknown field), and a model-level `warnings` entry or `complete: false` makes
  that model's metadata fail validation, so its resident reads `incomplete
  metadata` and carries the router's own warning text as the recorded reason. It
  is never relabeled as a qualification note, never another state, and never a
  reason to move a session — `scripts/patch-dsh-llm-pi-ai.mjs` turns the recorded
  state into a message and nothing else. Note that no row carrying
  `MODEL_HAS_NO_SERVICE_ID` can be a resident match at all, because §4 gives such
  a model `service` set to its canonical ID with no service alias declared.
- **Not applicable.** Harness sends only `/v1/responses`. The Ollama
  `x_router.stop_reason` form and the Chat Completions keepalive form do not
  occur, and `pick_service` by capability is not used.
- **Tools.** Every Harness agent request carries function tools, and the
  residents declare `tools`. A model without `tools` would be refused by the
  router with a 400 request error, which is not retried.
- **NSFW.** The optional badge `· NSFW` follows `models[].nsfw === true`. Harness
  adds no audience controls (§12); its users are the owner's trusted LAN.
