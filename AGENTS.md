# DSH environments

Develop in this local repository. Do not use Docker on this Mac; it consumes
too much RAM. Run host-compatible checks locally and container builds and
integration tests in GitHub CI.

`192.168.1.5` runs production DeepSeek Harness and Service Portal.
`192.168.1.4` runs the production model router and also has a separate
Harness installation at `/home/astigmatism/apps/dsh-container`.
Neither server is a development environment. Do not edit source or create
development files, worktrees, patches or test logs there. Do not patch their
containers or persisted configuration as a development shortcut.

Both servers receive reviewed, version-controlled source through their normal
Git/update and deployment workflows. Do not deploy without an explicit
production deployment request. Open WebUI is a separate application with a
different user-authorized workflow.

Preserve unrelated work and user settings. Keep credentials out of logs and
reports. For any authorized container operation, verify the host, repository
and Compose project first; container names alone do not identify an environment.

Service Portal Update and Restart is a required production compatibility
contract. Every release must qualify the existing maintenance entrypoint,
including supported adapters with separate source, deployment and credential
directories. Do not bypass failing acceptance checks to make an update green.

Deployment acceptance must not create user-visible chats, workspaces, drafts,
notifications, or model-preference changes in production. Browser startup itself
can create drafts. Run mutating UI/inference checks only through
`scripts/verify-isolated-runtime.py`, which owns disposable application storage;
keep production probes read-only. `DSH_VERIFY_ISOLATED=1` is an internal marker
for these disposable runtimes, not a production override. Run the repeated-live
isolation regression in Linux CI for verification or maintenance changes.
Every Harness deployment must expose a working Service Portal Update and restart
capability. Deployment constraints must be addressed by the shared updater and
deployment-local configuration, never by disabling the update labels. Maintenance
fetches a pinned source revision into temporary storage, verifies replacement
images, snapshots application state, and restores state and images on failure.
It must not require a permanent source checkout or edit deployment sources in
place. Keep destination identities and local deployment settings outside Git;
the intentional model-router and speech-service defaults remain application
dependencies. Qualify all supported topologies and custom deployment adoption
with synthetic fixtures before releasing changes.
