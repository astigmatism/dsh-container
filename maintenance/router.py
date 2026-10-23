"""The active LLM router is an environment fact, re-applied on every update.

Which router a deployment talks to is a property of the network the deployment
runs on. It is not a property of the source tree, and it is not a property of the
deployment mode that first created it, so an update must never carry forward the
mapping baked into the materialized model when the deployment was adopted.

The application only ever addresses the canonical name ``ai-router``
(``config/settings.yaml``, the resident routes, ``seed/plugins/
dsh-router-model-discovery.js``). That is what makes a migration one env edit:
the updater re-derives the ``ai-router`` mapping in the running config from
``REMOTE_OLLAMA_HOST`` on every update, so flipping the value and updating moves
this consumer to another router, and flipping it back moves it back the same
way. Nothing about the previous router changes, so it stays up as the backstop
until the consumer has verified on the new one.
"""
import ipaddress
import os
import socket
from pathlib import Path
from urllib.parse import urlsplit

from .common import Failure, atomic_json, atomic_text
from .contract import require

# The name the application resolves; the only router name a deployment may use.
CANONICAL_NAME = 'ai-router'
# The container path is http://ai-router:11434/v1 (docs/llm-router-contract.md
# §2). A router answering another port cannot be reached through an
# extra_hosts alias, so the setting is refused rather than quietly ignored.
API_PORT = 11434
ADMIN_PORT = 11435
SETTING = 'REMOTE_OLLAMA_HOST'
ADMIN_SETTING = 'REMOTE_OLLAMA_ADMIN_HOST'
RECORD = 'router.json'
# How far above the operational directory the deployment environment file is
# searched (deployment/.env, with the bundle at deployment/data/operations).
MAX_PARENT_LOOKUP = 4


class RouterSetting(Failure):
    """The active-router setting is missing or unusable; nothing was changed."""


def setting_value(text, name):
    """The value `name` has in an env-file body, or None when it is undeclared.

    The last declaration wins, matching how Compose reads an env file. A
    surrounding pair of quotes is stripped. The value is never logged: these
    files also hold credentials.
    """
    value = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or '=' not in stripped:
            continue
        key, _, raw = stripped.partition('=')
        if key.strip() != name:
            continue
        raw = raw.strip()
        if len(raw) > 1 and raw[0] == raw[-1] and raw[0] in ('"', "'"):
            raw = raw[1:-1]
        value = raw.strip()
    return value


def read_setting(path, name):
    path = Path(path)
    try:
        text = path.read_text()
    except OSError:
        return None
    return setting_value(text, name)


def os_environ(environ):
    """The environment to read the override from (injectable for tests)."""
    return os.environ if environ is None else environ


def candidate_env_files(root, manifest, environ=None):
    """Ordered files that may declare the active router; first declaration wins.

    1. ``$DSH_ROUTER_ENV_FILE`` — an explicit override for automation and tests.
    2. The environment file recorded by adoption, while it still exists.
    3. The deployment environment file above the operational directory — the
       private ``.env`` an operator edits.
    4. ``<operational>/env`` — the operational record written by every update,
       so a deployment whose checkout is gone still has an authoritative value.
    5. The environment file imported at adoption — last resort, so an adopted
       deployment never silently loses the value it was installed with.
    """
    environ = os_environ(environ)
    root = Path(root)
    candidates = []
    override = environ.get('DSH_ROUTER_ENV_FILE')
    if override:
        candidates.append(Path(override))
    recorded = manifest.get('env_file')
    if recorded:
        candidates.append(Path(recorded))
    directory = root
    for _ in range(MAX_PARENT_LOOKUP):
        directory = directory.parent
        if directory == directory.parent:
            break
        candidates.append(directory / '.env')
    candidates.append(root / 'env')
    imported = sorted((root / 'config-inputs').glob('*-.env'), reverse=True) if (root / 'config-inputs').is_dir() else []
    candidates.extend(imported)
    seen, files = set(), []
    for path in candidates:
        if path.is_file() and path not in seen:
            seen.add(path)
            files.append(path)
    return files


def select_setting(root, manifest, environ=None, name=SETTING):
    """The declared value of `name`, the file it came from, and any disagreeing file.

    The first file that declares it wins, in the documented order; a file lower
    in that order declaring a different value is reported as drift instead of
    being silently ignored, because an edit to a file the operator believed was
    authoritative is exactly how a router move goes missing.
    """
    files = candidate_env_files(root, manifest, environ)
    chosen = [(path, read_setting(path, name)) for path in files]
    declared = [(path, value) for path, value in chosen if value]
    drift = sorted({str(path) + ' declares ' + name for path, value in declared[1:]
                    if declared and value != declared[0][1]})
    if not declared:
        return None, None, drift
    path, value = declared[0]
    return value, str(path), drift


def resolve_address(hostname, port=API_PORT):
    """The address `hostname` answers on this network; fail closed if it does not."""
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        return str(literal)
    try:
        infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        raise RouterSetting(f'{hostname} does not resolve; {SETTING} must name a router host '
                            'this machine can reach') from None
    for family, _, _, _, address in infos:
        if family == socket.AF_INET:
            return address[0]
    for _, _, _, _, address in infos:
        return address[0]
    raise RouterSetting(f'{hostname} does not resolve to an address')


def usable_address(address, source):
    ip = ipaddress.ip_address(address)
    if ip.is_loopback or ip.is_unspecified:
        raise RouterSetting(f'{source} resolves to {address}, which is this machine itself; the router '
                            'must be reachable from a container, so name its LAN address')
    return str(ip)


def parse_base(raw, name, default_port):
    """Normalize one accepted spelling of a router base into (hostname, port).

    Accepted: ``192.168.1.23``, ``router.lan``, ``router.lan:11434``,
    ``http://192.168.1.23:11434``, ``http://192.168.1.23:11434/v1``. Anything
    the deployment could not honour fails closed instead of being reinterpreted.
    """
    text = str(raw).strip()
    candidate = text if '://' in text else 'http://' + text
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError:
        raise RouterSetting(f'{name} "{text}" is not a host or URL') from None
    require(parts.scheme == 'http', f'{name} "{text}" must name a host or an http URL; this network '
                                    f'reaches the router over plain HTTP, not TLS')
    require(parts.hostname, f'{name} "{text}" names no host')
    require(not parts.username and not parts.password, f'{name} "{text}" must not embed credentials')
    require(not parts.query and not parts.fragment, f'{name} "{text}" must not carry a query or fragment')
    require(parts.path in ('', '/', '/v1', '/v1/'), f'{name} "{text}" must be a router base, not an API path')
    port = default_port if port is None else port
    require(port == default_port, f'{name} "{text}" uses port {port}, but {default_port} is the port this '
                                  f'setting names; the container reaches the API through the '
                                  f'{CANONICAL_NAME} alias, which carries an address and not a port')
    return parts.hostname.lower(), port


def parse_admin(value):
    """The router admin portal base, which answers on its own port."""
    hostname, port = parse_base(value, ADMIN_SETTING, ADMIN_PORT)
    address = resolve_address(hostname, port)
    usable_address(address, hostname)
    return {'admin_hostname': hostname, 'admin_address': address,
            'admin_base': f'http://{hostname}:{port}'}


def parse_endpoint(value, admin=None):
    """The endpoint fact for the active-router setting, plus its admin base."""
    hostname, port = parse_base(value, SETTING, API_PORT)
    address = usable_address(resolve_address(hostname, port), hostname)
    fact = {'hostname': hostname, 'address': address, 'port': port,
            'api_base': f'http://{hostname}:{port}/v1',
            'api_container_base': f'http://{CANONICAL_NAME}:{port}/v1'}
    if admin:
        fact.update(parse_admin(admin))
        fact['admin_source'] = 'declared'
    else:
        fact['admin_base'] = f'http://{hostname}:{ADMIN_PORT}'
        fact['admin_source'] = 'derived from ' + SETTING
    return fact


def harness_service(model, manifest):
    roles = manifest.get('roles') or {}
    for service, role in roles.items():
        if role == 'harness':
            require(service in model.get('services', {}), 'The Harness service is missing from the model')
            return service
    raise RouterSetting('The deployment manifest names no Harness service')


def alias_of(entry):
    """Split an extra-hosts entry into (name, address), accepting both spellings.

    Compose renders `ai-router=192.168.1.4` and accepts `ai-router:192.168.1.4`;
    an operator may have written either, and a hand-edited materialized model
    must still be recognized as the canonical router alias.
    """
    name, separator, address = str(entry).partition('=')
    if not separator:
        name, _, address = str(entry).partition(':')
    return name, address


def deployed_mapping(model, manifest):
    """The `ai-router` mapping the materialized model carries today, if any."""
    service = model.get('services', {}).get(harness_service(model, manifest), {})
    for entry in service.get('extra_hosts') or []:
        name, address = alias_of(entry)
        if name == CANONICAL_NAME:
            return f'{CANONICAL_NAME}={address}'
    return None


def without_router_hosts(entries):
    """Every extra host that is not the canonical router alias.

    Only the alias is addressed, so an extra host an operator added for another
    purpose survives a router move.
    """
    kept = []
    for entry in entries or []:
        name, address = alias_of(entry)
        if name != CANONICAL_NAME:
            kept.append(str(entry))
    return kept


def plan(model, manifest, root, environ=None):
    """Decide the router mapping for this deployment: the mapping and its fact.

    Pure with respect to the model: callers apply the mapping, and callers that
    only report (`--dry-run`, the updater's report action) never write anything.
    """
    service = harness_service(model, manifest)
    current = deployed_mapping(model, manifest)
    mode = manifest.get('mode')
    value, source, drift = select_setting(root, manifest, environ)
    fact = {'status': 'applied', 'setting': value, 'source': source, 'drift': drift,
            'previous': current, 'mode': mode, 'name': CANONICAL_NAME}
    if mode != 'remote':
        # external and managed resolve ai-router inside Docker (a shared network
        # or the bundled router service). The mode still decides this, and the
        # stale alias is removed rather than carried forward, so switching mode
        # and switching router behave the same way: the config is re-derived.
        fact['status'] = 'mode-resolved'
        fact['reason'] = f'{mode} mode resolves {CANONICAL_NAME} through Docker, not through {SETTING}'
        return without_router_hosts(model['services'][service].get('extra_hosts')), fact
    if not value:
        # Nothing declares the router. Keep the deployed mapping instead of
        # inventing a default the source no longer knows about, and say so.
        fact['status'] = 'undeclared'
        fact['reason'] = f'No {SETTING} declaration was found; the deployed mapping is kept'
        kept = [entry for entry in [current] if entry]
        return kept + without_router_hosts(model['services'][service].get('extra_hosts')), fact
    admin, _, _ = select_setting(root, manifest, environ, ADMIN_SETTING)
    endpoint = parse_endpoint(value, admin)
    fact.update(endpoint)
    fact['mapping'] = f'{CANONICAL_NAME}={endpoint["address"]}'
    return [fact['mapping']] + without_router_hosts(model['services'][service].get('extra_hosts')), fact


def apply(model, manifest, root, environ=None):
    """Re-derive the router endpoint and write it into the model. Authoritative.

    The model is the only thing changed: the record of the decision travels with
    the release and reaches the operational directory at cutover, so a failed
    build never leaves a record claiming a mapping that was never deployed.
    """
    mapping, fact = plan(model, manifest, root, environ)
    service = harness_service(model, manifest)
    model['services'][service]['extra_hosts'] = mapping
    return fact


def write(path, fact):
    atomic_json(Path(path), fact)


def describe(fact):
    """One human-readable line about the decision, without private values."""
    if fact['status'] == 'mode-resolved':
        return f'{CANONICAL_NAME} is resolved by Docker ({fact["mode"]} mode); {SETTING} does not apply'
    if fact['status'] == 'undeclared':
        return (f'{SETTING} is not declared; keeping the deployed mapping '
                f'{fact["previous"] or "(none)"}')
    moved = '' if fact['previous'] == fact['mapping'] else f' (was {fact["previous"] or "unmapped"})'
    return (f'{CANONICAL_NAME} -> {fact["address"]} from {SETTING}={fact["setting"]} '
            f'in {fact["source"]}; API {fact["api_container_base"]}, admin {fact["admin_base"]}{moved}')


def report(fact):
    """Print the decision for the operator, and hand the fact back."""
    print('Active LLM router: ' + describe(fact), flush=True)
    for note in fact['drift']:
        print('Router note: a lower-priority file declares another value — ' + note, flush=True)
    return fact


def setting_target(root, manifest, environ=None):
    """The file a supported change must write: the authoritative one, or the record.

    If a file already declares the setting, that file is the authority and is the
    one edited. Otherwise the deployment ``.env`` above the operational directory
    is used when one exists; failing that, the operational record ``<root>/env``,
    which keeps a checkout-free deployment configurable.
    """
    _, source, _ = select_setting(root, manifest, environ)
    if source:
        return Path(source)
    root = Path(root)
    directory = root
    for _ in range(MAX_PARENT_LOOKUP):
        directory = directory.parent
        if directory == directory.parent:
            break
        if (directory / '.env').is_file():
            return directory / '.env'
    return root / 'env'


def rewrite_setting(path, name, value):
    """Set `name` to `value` in an env file, leaving every other line untouched.

    Returns the previous value. A declaration is replaced where it stands, so the
    file's own ordering and comments survive; with no declaration the setting is
    appended.
    """
    path = Path(path)
    text = path.read_text() if path.is_file() else ''
    lines = text.splitlines()
    previous = None
    found = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or '=' not in stripped:
            continue
        key, _, _ = stripped.partition('=')
        if key.strip() != name:
            continue
        previous = setting_value(line, name)
        lines[index] = f'{name}={value}'
        found = True
    if not found:
        if lines and not lines[-1].strip():
            lines.pop()
        lines.append(f'{name}={value}')
        if not text.strip():
            lines.insert(0, f'# The active LLM router for this DSH deployment. Changing this one')
            lines.insert(1, f'# setting and updating moves this consumer between routers; see README.md.')
    body = '\n'.join(lines) + '\n'
    atomic_text(path, body)
    return previous


def stale_admin_base(declared, hostname):
    """A declared admin base that belongs to a different router, if it parses.

    The admin portal is recorded information, so an unparseable or unrelated
    value is reported, never a reason to refuse a router move.
    """
    if not declared:
        return None
    try:
        return None if parse_admin(declared)['admin_hostname'] == hostname else declared
    except Failure:
        return None


def configure(root, manifest, value, admin=None, environ=None):
    """Move this deployment to another router: write the one authoritative setting.

    The value is resolved before anything is written, so a router that cannot be
    reached by name, is this machine itself, or answers another port fails
    without touching the deployment. Reversible by the same call with the value
    the previous call reports.
    """
    endpoint = parse_endpoint(value, admin) if admin else parse_endpoint(value)
    target = setting_target(root, manifest, environ)
    declared_admin, _, _ = select_setting(root, manifest, environ, ADMIN_SETTING)
    previous, previous_admin = rewrite_setting(target, SETTING, value.strip()), None
    if admin:
        previous_admin = rewrite_setting(target, ADMIN_SETTING, admin.strip())
    return {'file': str(target), 'previous': previous, 'previous_admin': previous_admin,
            'value': value.strip(), 'admin': (admin or '').strip() or None,
            # A declared admin base usually belongs to the router it was declared
            # with, so a move that leaves it behind is worth saying out loud.
            'stale_admin': None if admin else stale_admin_base(declared_admin, endpoint['hostname']),
            'endpoint': endpoint}


def probe(fact, instance, timeout=10):
    """Ask the router we are about to trust whether it is serving.

    The backstop rule for a gradual migration is that a consumer is never left
    with nothing serving, so a flip first checks the new router answers the
    contract's discovery route (docs/llm-router-contract.md §2, §4).
    """
    from urllib.request import Request, urlopen
    headers = {'X-Client-Name': f'deepseek-harness/{instance}' if instance else 'deepseek-harness'}
    for route in ('/router/capabilities', '/models'):
        try:
            with urlopen(Request(fact['api_base'] + route, headers=headers), timeout=timeout) as response:
                if response.status == 200:
                    return {'reachable': True, 'route': fact['api_base'] + route}
        except Exception:
            continue
    raise RouterSetting(f'{fact["api_base"]} did not answer /v1/router/capabilities or /v1/models; '
                        'the new router must serve before this consumer is moved to it')
