export interface HomeCopyWorkerInput {
  operationId: string;
  sourceLayout: "flat" | "portable";
}

export function homeCopyStartupScript(input: HomeCopyWorkerInput): string {
  if (!/^[a-z0-9-]{1,63}$/u.test(input.operationId)) throw new Error("invalid home copy operation ID");
  const config = Buffer.from(JSON.stringify(input)).toString("base64");
  return `#!/bin/bash
set -euo pipefail
setup_failed() {
  echo 'OCTOGEE_HOME_COPY_FAILED:{"operationId":"${input.operationId}","error":"copy worker setup failed"}' >&2
}
trap setup_failed ERR
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update -qq
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y -qq rsync btrfs-progs python3
trap - ERR
exec python3 - '${config}' <<'OCTOGEE_HOME_COPY'
${HOME_COPY_WORKER}
OCTOGEE_HOME_COPY
`;
}

export const HOME_COPY_WORKER = String.raw`
import base64, hashlib, json, os, pathlib, stat, subprocess, sys, time
config = json.loads(base64.b64decode(sys.argv[1]))
operation = config['operationId']
source = pathlib.Path('/mnt/octogee-source')
target = pathlib.Path('/mnt/octogee-target')
def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)
def device(name):
    choices = [pathlib.Path('/dev/disk/by-id/google-' + name), pathlib.Path('/dev/disk/by-id/scsi-0Google_PersistentDisk_' + name)]
    for _ in range(1800):
        for candidate in choices:
            if candidate.exists(): return str(candidate)
        time.sleep(1)
    raise RuntimeError('copy disk did not attach: ' + name)
def emit(kind, payload):
    print('OCTOGEE_HOME_COPY_' + kind + ':' + json.dumps({'operationId': operation, **payload}, sort_keys=True), flush=True)
def mapping(root):
    global portable
    portable = config['sourceLayout'] == 'portable' or ((root / 'volumes/data').is_dir() and (root / 'desktop-home').is_dir())
    if portable:
        return [(root / 'volumes/data', 'volumes/data'), (root / 'desktop-home', 'desktop-home')]
    return [(root, 'volumes/data')]
def verify_directory(path):
    if not stat.S_ISDIR(path.lstat().st_mode): raise RuntimeError('home path is not a directory: ' + str(path))
def copy_tree(origin, destination):
    verify_directory(origin)
    tree_hash(origin)
    destination.mkdir(parents=True, exist_ok=True)
    run('rsync', '-aHAX', '--no-specials', '--no-devices', '--info=NONREG0', '--numeric-ids', '--one-file-system', '--delete', '--exclude=/lost+found', str(origin) + '/', str(destination) + '/')
    verification = run('rsync', '-aHAXnc', '--no-specials', '--no-devices', '--info=NONREG0', '--numeric-ids', '--one-file-system', '--delete', '--itemize-changes', '--exclude=/lost+found', str(origin) + '/', str(destination) + '/', capture_output=True)
    if verification.stdout.strip(): raise RuntimeError('copied home differs from its snapshot: ' + verification.stdout[:2048])
def tree_hash(root):
    digest = hashlib.sha256()
    for current, dirs, files in os.walk(root, followlinks=False):
        if pathlib.Path(current) == root:
            dirs[:] = [name for name in dirs if name != 'lost+found']
            files = [name for name in files if name != 'lost+found']
        dirs.sort(); files.sort()
        for name in sorted(dirs + files):
            item = pathlib.Path(current) / name
            relative = str(item.relative_to(root))
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode): content = os.readlink(item)
            elif stat.S_ISREG(info.st_mode):
                content_hash = hashlib.sha256()
                with item.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''): content_hash.update(chunk)
                content = content_hash.hexdigest()
            elif stat.S_ISDIR(info.st_mode): content = ''
            elif stat.S_ISSOCK(info.st_mode): continue
            else: raise RuntimeError('unsupported special file in home: ' + relative)
            digest.update(json.dumps([relative, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, content], separators=(',', ':')).encode())
    return digest.hexdigest()
try:
    source.mkdir(parents=True, exist_ok=True)
    source_device = device('octogee-source')
    run('mount', source_device, str(source))
    run('mount', '-o', 'remount,ro', str(source))
    mappings = mapping(source)
    used = 0
    for origin, _ in mappings:
        verify_directory(origin)
        used += int(run('du', '-sx', '--apparent-size', '--block-size=1', str(origin), capture_output=True).stdout.split()[0])
    emit('PROBE', {'usedBytes': used})
    target_device = device('octogee-target')
    target.mkdir(parents=True, exist_ok=True)
    probe = subprocess.run(['blkid', '-p', '-s', 'TYPE', '-o', 'value', target_device], capture_output=True, text=True)
    filesystem = 'btrfs'
    if probe.returncode == 2:
        run('mkfs.' + filesystem, '-q', target_device)
    elif probe.returncode != 0 or probe.stdout.strip() != filesystem:
        raise RuntimeError('target disk is not blank or the expected filesystem')
    run('mount', target_device, str(target))
    marker = target / '.octogee-copy-operation'
    if marker.exists():
        if marker.read_text() != operation: raise RuntimeError('copy target belongs to another operation')
    elif any(entry.name != 'lost+found' for entry in target.iterdir()):
        raise RuntimeError('unmarked target contains data')
    marker.write_text(operation)
    for origin, relative in mappings: copy_tree(origin, target / relative)
    desktop = target / 'desktop-home'
    desktop.mkdir(exist_ok=True)
    os.chown(desktop, 1000, 1000)
    if not portable:
        for relative in ['.config/octogee-chromium', '.openclaw-desktop', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']:
            old = target / 'volumes/data' / relative
            new = desktop / relative
            if old.exists() or old.is_symlink():
                new.parent.mkdir(parents=True, exist_ok=True)
                os.chown(new.parent, 1000, 1000)
                if new.exists() or new.is_symlink(): raise RuntimeError('desktop conversion collision')
                old.rename(new)
    layout = target / '.octogee-home-layout.json'
    layout.write_text(json.dumps({'version': 1, 'agent': 'volumes/data', 'desktop': 'desktop-home'}))
    for name in ['.octogee-native-seeded']:
        if (source / name).is_file(): run('cp', '-a', str(source / name), str(target / name))
    proof = {relative: tree_hash(target / relative) for relative in ['volumes/data', 'desktop-home']}
    run('sync', '-f', str(target))
    run('umount', str(target))
    run('mount', '-o', 'ro', target_device, str(target))
    if proof != {relative: tree_hash(target / relative) for relative in proof}: raise RuntimeError('target read-back verification failed')
    run('umount', str(target))
    run('umount', str(source))
    emit('READY', {'usedBytes': used, 'filesystem': filesystem, 'proof': proof})
except BaseException as error:
    emit('FAILED', {'error': str(error)})
    raise
`;
