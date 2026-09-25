#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
# Initial installation/adoption requires Python 3.11+ and Docker. Subsequent
# Portal updates use only the packaged maintenance runtime.
exec python3 -B "$source_root/maintenance/main.py" install "$@"
