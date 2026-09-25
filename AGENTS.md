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
