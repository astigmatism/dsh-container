# DSH environments

Develop and test in this local repository and the Mac's local DSH containers.

`192.168.1.5` runs production DeepSeek Harness and Service Portal.
`192.168.1.21` runs the production model router and also has a separate
Harness installation at `/home/astigmatism/apps/dsh-container`.
Neither server is a development environment. Do not edit source or create
development files, worktrees, patches or test logs there. Do not patch their
containers or persisted configuration as a development shortcut.

Both servers receive reviewed, version-controlled source through their normal
Git/update and deployment workflows. Do not deploy without an explicit
production deployment request. Open WebUI is a separate application with a
different user-authorized workflow.

Preserve unrelated work and user settings. Keep credentials out of logs and
reports. Check the repository and running Compose project before choosing an
environment; the Mac and production both have containers named deepseek-harness.
