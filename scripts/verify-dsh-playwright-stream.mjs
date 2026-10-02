#!/usr/bin/env node
// Maintenance schema 1 callers released before Harness 0.2 use this path.
// Keep the entry point across image upgrades; qualify the current browser.
await import('./verify-ego-routes.mjs');
