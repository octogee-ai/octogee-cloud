import os
import subprocess
from pathlib import Path

session = None
for process in Path('/proc').iterdir():
    if not process.name.isdigit():
        continue
    try:
        if b'/benchmark/session.sh' in (process / 'cmdline').read_bytes().split(b'\0'):
            session = process
            break
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
if session is None:
    raise RuntimeError('Desktop session is not running')
environment = os.environ.copy()
for field in (session / 'environ').read_bytes().split(b'\0'):
    key, separator, value = field.partition(b'=')
    if separator and key.decode() in {'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'GTK_MODULES', 'NO_AT_BRIDGE'}:
        environment[key.decode()] = value.decode()
for name, command in [
    ('terminal', ['xterm', '-e', 'bash', '-lc', 'node --version; git --version; sleep 600']),
    ('files', ['pcmanfm', '/home/node/workspace']),
]:
    with Path(f'/home/node/results/{name}.log').open('w') as output:
        subprocess.Popen(command, env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
