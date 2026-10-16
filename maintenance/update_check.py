"""Service Portal update check for an installed deployment.

The portal runs the operational update script with the single argument
`check` in the same detached runner an update uses. That runner mounts only
this operational bundle and the Docker socket, so a check works from the
bundle alone: no source checkout, no service access, no maintenance lock, and
nothing written outside a temporary directory. Fetching is allowed.

Output is the portal check protocol on stdout; the last summary line wins:

  service-portal-check: status=<current|available> behind=<n|unknown> deployed=<sha|unknown> target=<sha|unknown>
  service-portal-check-commit: <sha> <ISO-8601 date> <subject>   (newest first, optional)
  service-portal-check-note: <text>                              (optional)

A comparison this deployment cannot make is reported as `available` with
`unknown`, never as an error: only a successful `current` may disable the
portal control, so a surprising manifest must not silently block updates.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from .common import Failure, run
from .contract import require

BRANCH = re.compile(r'^[A-Za-z0-9._/-]{1,100}$')
REVISION = re.compile(r'^[0-9a-f]{7,40}$')
# The portal shows at most this many commits, newest first.
MAX_COMMITS = 10
SUMMARY = 'service-portal-check: '
COMMIT = 'service-portal-check-commit: '
NOTE = 'service-portal-check-note: '


def _environment():
    # Never read a host or global Git configuration, and never prompt: the
    # runner has no terminal and the canonical repository is public.
    return dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
                GIT_TERMINAL_PROMPT='0')


def _git(workdir, *arguments, env):
    return run(['git', '-c', 'credential.helper=', *arguments], cwd=workdir, env=env)


def _status(workdir, *arguments, env):
    # Comparison questions are answered by an exit code, not by output.
    result = subprocess.run(['git', '-c', 'credential.helper=', *arguments], cwd=workdir,
                            env=env, capture_output=True, text=True)
    return result.returncode


def _fetch_canonical(repository, branch):
    """Return (workdir, target) for a throwaway repository holding the commits
    of canonical `branch`. The caller owns the directory and must remove it."""
    env = _environment()
    workdir = Path(tempfile.mkdtemp(prefix='dsh-update-check.')).resolve()
    try:
        _git(str(workdir), 'init', '--quiet', '.', env=env)
        _git(str(workdir), 'remote', 'add', 'origin', repository, env=env)
        refspec = f'refs/heads/{branch}:refs/remotes/origin/check'
        base = ['fetch', '--quiet', '--no-tags']
        try:
            # Comparing two revisions needs commit objects only, so a treeless
            # fetch keeps a check that repeats every few minutes cheap.
            _git(str(workdir), *base, '--filter=tree:0', 'origin', refspec, env=env)
        except Failure:
            _git(str(workdir), *base, 'origin', refspec, env=env)
        target = _git(str(workdir), 'rev-parse', '--verify', 'refs/remotes/origin/check',
                      env=env).strip()
        require(re.fullmatch(r'[0-9a-f]{40}', target), 'Canonical branch does not resolve to one commit')
        return str(workdir), target
    except BaseException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise


def report(manifest, deployed):
    """Print the portal check protocol comparing the running image's recorded
    source revision with canonical main. Read-only for services and state."""
    repository = str(manifest['repository'])
    branch = str(manifest['branch'])
    require(BRANCH.fullmatch(branch), 'Deployment manifest names an invalid branch')
    deployed = str(deployed or '').strip().lower()
    workdir = None
    try:
        workdir, target = _fetch_canonical(repository, branch)
        env = _environment()
        if not REVISION.fullmatch(deployed):
            print(NOTE + 'The running image does not record its source revision.', flush=True)
            print(SUMMARY + f'status=available behind=unknown deployed=unknown target={target}',
                  flush=True)
            return
        if _status(workdir, 'cat-file', '-e', deployed + '^{commit}', env=env):
            print(NOTE + 'The running revision is not in the fetched history.', flush=True)
            print(SUMMARY + f'status=available behind=unknown deployed={deployed} target={target}',
                  flush=True)
            return
        deployed = _git(workdir, 'rev-parse', deployed + '^{commit}', env=env).strip()
        if deployed == target:
            print(SUMMARY + f'status=current behind=0 deployed={deployed} target={target}', flush=True)
            return
        behind = 'unknown'
        if _status(workdir, 'merge-base', '--is-ancestor', deployed, target, env=env) == 0:
            span = f'{deployed}..{target}'
            behind = _git(workdir, 'rev-list', '--count', span, env=env).strip()
            for line in _git(workdir, 'log', f'--max-count={MAX_COMMITS}',
                             '--format=%H %cI %s', span, env=env).splitlines():
                if line.strip():
                    print(COMMIT + line.strip(), flush=True)
        else:
            print(NOTE + 'The running revision is not an ancestor of the canonical branch.',
                  flush=True)
        print(SUMMARY + f'status=available behind={behind} deployed={deployed} target={target}',
              flush=True)
    finally:
        if workdir is not None:
            shutil.rmtree(workdir, ignore_errors=True)
