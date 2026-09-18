#!/bin/sh
# Install the published CLI with its reviewed, complete dependency graph.
# A top-level npm version pin alone admits newer prerelease DSH internals.
set -eu
version=${1:?Harness version is required}
lock=/opt/dsh-build/dsh-runtime.package-lock.json
runtime=/usr/local/lib/node_modules/@deepseek-ai/dsh

node - "$lock" "$version" <<'NODE'
const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = process.argv[3];
if (lock.name !== '@deepseek-ai/dsh' || lock.version !== expected) {
  throw new Error(`Requested DSH_VERSION=${JSON.stringify(expected)}, but the reviewed runtime lock is ${lock.name}@${lock.version}. Use the repository Dockerfile pins; a Harness upgrade requires a matching reviewed runtime lock.`);
}
if (lock.packages?.['']?.name !== lock.name || lock.packages?.['']?.version !== expected) {
  throw new Error('Runtime lock root package does not match its reviewed Harness version');
}
for (const [path, entry] of Object.entries(lock.packages)) {
  if (/(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(path) && entry.version !== expected) {
    throw new Error(`Mixed Harness generation in runtime lock: ${path}@${entry.version}`);
  }
}
NODE

[ ! -e "$runtime" ] || { echo "Runtime installation directory already exists: $runtime" >&2; exit 1; }
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
npm pack "@deepseek-ai/dsh@$version" --pack-destination "$temporary" --quiet >/dev/null
mkdir -p "$runtime"
tar -xzf "$temporary/deepseek-ai-dsh-$version.tgz" --strip-components=1 -C "$runtime"
cp "$lock" "$runtime/package-lock.json"
npm ci --prefix "$runtime" --omit=dev --no-audit --no-fund
ln -s "$runtime/lib/bin.js" /usr/local/bin/dsh
node - "$runtime" "$version" <<'NODE'
const fs = require('node:fs');
const root = process.argv[2];
const expected = process.argv[3];
const manifests = [root, ...fs.readdirSync(`${root}/node_modules/@deepseek-ai`)
  .filter(name => name === 'dsh' || name.startsWith('dsh-'))
  .map(name => `${root}/node_modules/@deepseek-ai/${name}`)];
for (const directory of manifests) {
  const manifest = JSON.parse(fs.readFileSync(`${directory}/package.json`, 'utf8'));
  if (manifest.version !== expected) throw new Error(`Unexpected installed version: ${manifest.name}@${manifest.version}`);
}
console.log(`Verified ${manifests.length} installed Harness packages at ${expected}.`);
NODE
