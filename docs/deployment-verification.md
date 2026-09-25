# Deployment verification without production conversations

The September 25, 2026 failure on `192.168.1.23` occurred after image build and
container health succeeded. Job `11d9dd58-7b4e-4fb8-b2fd-c7ad1d12a403` timed out
looking for a temporary workspace in the production sidebar. The operator had
canceled unexpected verification chats; the saved initial turn ended with a
user-style abort. The verifier treated idle as ready, then failed during UI
navigation. The exact reason the workspace was absent remains unproven; the
current client still supports the old selector.

Verification now runs the candidate image in a disposable container. It copies
only deployment preferences: either legacy settings and the user profile patch,
or the migrated profile patch and its migration marker, plus the private provider
credential store when present. Credential values are redacted from diagnostic
logs. It does not copy user
sessions, workspaces, storage, host mounts, Docker socket access or published
ports. It retains the deployment UID/GID, environment and provider networks.
All browser-created drafts and test conversations disappear with that container.

`python3 scripts/verify-isolated-runtime.py --container CONTAINER_ID --image IMAGE_ID
--diagnostics PRIVATE_DIRECTORY` qualifies a candidate while the settings source
is running. Omitting `--image` qualifies the installed image. Callers must resolve
the source ID from the intended Compose project, not assume a container name is
unique. The same tool works inside the detached Service Portal runner because
settings transfer uses Docker exec streams, not host paths interpreted locally.

The gate runs native terminal, mounted browser integrations, dictation control,
resident model picker, reasoning control and live application inference checks.
Production checks use read-only inventory and model-catalog RPCs. Mutating probes
refuse to run without the disposable-runtime marker. A unique private runtime
and `finally` cleanup isolate success, failure and handled interruption. Docker
Engine loss or an uncatchable worker kill can leave an orphan container; its
`io.dsh.verification=isolated` label identifies it, and it has no production data
mounts. Never delete a container based only on a name prefix.

Cancellation, provider error, missing session, missing workspace, unexpected
tool use and timeout have distinct errors. The initial live prompt must actually
produce `READY`; stopping it is not success. Inference checks consider only the
current prompt's events. On failure, the caller retains private, redacted startup
and browser diagnostics. No production page or conversation is captured.

Linux CI runs `tests/isolated-verification-docker.test.py` with the built image,
an arbitrary service UID and a deterministic Responses provider. It populates
a separate production fixture, runs acceptance twice, rejects provider failure,
and compares session/storage/settings content before and after. Unit tests cover
cancellation and missing-fixture classification, isolation boundaries and redaction.
The same gate deliberately runs the incident's verifier against that disposable
production fixture as a negative control: its persisted-state changes must fail
the assertion that the fixed path passes. Cancellation and handled interruption
also run against real application processes and must leave production unchanged.

The mandatory `scripts/check.sh --build` gate also builds actual previous release
`5742e98463c1dcc8a39f7a0e816e304794702530` (Harness 0.1.6-alpha.1). Only the
maintenance dispatcher is backported for the CI bridge; its application and
profile remain from that release. The real Portal dispatches the upgrade to the
candidate, repeats it while an ordinary conversation is canceled/archived, and
injects a failed post-start check. It verifies preserved conversations and
automatic recovery using separate deployment, state and credential directories.
Synthetic remote and managed cases separately qualify adoption, legacy update
entrypoints, TLS, detached dispatch, and recovery without modifying unrelated
containers or shared model data.

Candidate acceptance runs while the existing deployment is available. At
cutover, all application writers stop before the snapshot. The new gateway
refuses writable requests and WebSocket connections until read-only post-start
checks pass; removing its private maintenance marker commits the deployment.
Thus rollback cannot discard writes accepted by an uncommitted candidate.
Read-only external inputs are never restored over concurrent operator changes.
A failed check remains a failed update even when the previous deployment recovers.
