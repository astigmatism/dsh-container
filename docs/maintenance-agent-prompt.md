# Maintenance agent prompt

Use the installed checkout-free maintenance workflow. Do not fetch into, modify,
or fast-forward a production application checkout.

> Confirm the Docker Engine, Compose project and operational manifest match the
> intended deployment. Keep credentials and resolved Compose content out of logs.
> Run the installed updater's `--dry-run` before maintenance. When the requested
> operation is authorized, use Service Portal Update and restart, or the installed
> `scripts/update-and-restart.sh --manifest PATH/deployment.json` entrypoint.
> Preserve declared state and all recovery points. If a transaction is interrupted,
> let the updater recover it before another release. Do not delete its journal or
> merely restart failed containers. Report the update result and recovery outcome
> separately; a successful rollback is still a failed update. Confirm authenticated
> gateway access, provider discovery and live Portal update capability before
> reporting success. Do not use global pruning or change unrelated services.

An installation without an operational manifest requires a reviewed bootstrap or
adoption, not a fallback to Git self-update. See [portable maintenance](portable-maintenance.md).
