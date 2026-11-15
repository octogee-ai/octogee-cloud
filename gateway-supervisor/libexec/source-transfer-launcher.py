import json
import os
import pathlib
import resource
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

MIB = 1024 * 1024
MAX_SECONDS = 600
MAX_SCRATCH = 512 * MIB
STAGE = '/octogee/scripts/source-transfer-stage.mjs'
CURRENT_PHASE = 'admission'


def resource_admission(admission, meminfo, free_disk, now):
    if set(admission) != {'observedAt', 'sourceMemoryMax', 'sourceMemoryCurrent'}:
        raise ValueError('invalid resource admission')
    if any(type(value) is not int or value < 0 for value in admission.values()):
        raise ValueError('invalid resource admission')
    if not 0 <= now - admission['observedAt'] <= 30000:
        raise ValueError('stale resource admission')
    if admission['sourceMemoryMax'] - admission['sourceMemoryCurrent'] < 4096 * MIB:
        raise ValueError('insufficient source headroom')
    if meminfo < 4096 * MIB or free_disk < 1024 * MIB:
        raise ValueError('insufficient host resources')


def readonly_source(mountinfo):
    found = False
    for line in mountinfo.splitlines():
        fields = line.split()
        if len(fields) <= 6:
            continue
        if fields[4] == '/home/node' or fields[4].startswith('/home/node/'):
            if 'ro' not in fields[5].split(','):
                raise ValueError('source mount is not read only')
            found = found or fields[4] == '/home/node'
    if not found:
        raise ValueError('source mount is not read only')


def read_request(stream, deadline):
    data = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
            raise TimeoutError('request deadline exceeded')
        chunk = os.read(stream.fileno(), 65536)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MIB:
            raise ValueError('request too large')
    return bytes(data)


def child_limits(address_space):
    resource.setrlimit(resource.RLIMIT_AS, (address_space, address_space))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_STACK, (2 * MIB, 2 * MIB))
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 * MIB, 256 * MIB))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_NPROC, (4096, 4096))


def namespace_thread_count():
    count = 0
    for process in pathlib.Path('/proc').iterdir():
        if not process.name.isdecimal():
            continue
        try:
            count += sum(1 for _ in (process / 'task').iterdir())
        except FileNotFoundError:
            continue
    return count


def scratch_size(scratch):
    return sum(p.stat().st_size for p in pathlib.Path(scratch).rglob('*') if p.is_file())


def run_child(argv, env, scratch, output, deadline, address_space=1536 * MIB):
    with open(output, 'wb') as out, open(os.devnull, 'wb') as err:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err,
                                 env=env, cwd=scratch, start_new_session=True,
                                 preexec_fn=lambda: child_limits(address_space))
        written = 0
        try:
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError('transfer deadline exceeded')
                if namespace_thread_count() > 64:
                    raise ValueError('helper namespace thread budget exceeded')
                if scratch_size(scratch) > MAX_SCRATCH:
                    raise ValueError('scratch limit exceeded')
                ready = select.select([child.stdout], [], [], 0.05)[0]
                if ready:
                    chunk = os.read(child.stdout.fileno(), 65536)
                    written += len(chunk)
                    if written > 2 * MIB:
                        raise ValueError('transfer output exceeds limit')
                    out.write(chunk)
                    if not chunk and child.poll() is not None:
                        break
                elif child.poll() is not None:
                    continue
            if child.returncode != 0:
                raise ValueError('transfer subprocess failed')
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            child.stdout.close()
    if scratch_size(scratch) > MAX_SCRATCH:
        raise ValueError('scratch limit exceeded')


def install_signal_handlers():
    def interrupted(_signum, _frame):
        raise InterruptedError('transfer interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(MAX_SECONDS)


def main():
    global CURRENT_PHASE
    install_signal_handlers()
    deadline = time.monotonic() + MAX_SECONDS
    if len(sys.argv) != 2 or os.getuid() == 0:
        raise ValueError('invalid helper invocation')
    resource.setrlimit(resource.RLIMIT_AS, (512 * MIB, 1536 * MIB))
    execution_id = sys.argv[1]
    readonly_source(pathlib.Path('/proc/self/mountinfo').read_text())

    os.umask(0o077)
    scratch = tempfile.mkdtemp(prefix='octogee-source-transfer-', dir='/tmp')
    try:
        request_data = read_request(sys.stdin, min(deadline, time.monotonic() + 30))
        request = json.loads(request_data)
        available = next(int(line.split()[1]) * 1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
        resource_admission(request['resourceAdmission'], available, shutil.disk_usage('/tmp').free, int(time.time() * 1000))
        request_path = pathlib.Path(scratch, 'request.json')
        request_path.write_bytes(request_data)
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'NO_COLOR': '1',
               'HOME': scratch, 'TMPDIR': scratch, 'SOURCE_POD_UID': os.environ.get('SOURCE_POD_UID', ''),
               'NODE_OPTIONS': '--jitless --max-old-space-size=192 --max-semi-space-size=4 --v8-pool-size=1',
               'UV_THREADPOOL_SIZE': '1', 'NODE_DISABLE_COMPILE_CACHE': '1', 'OPENCLAW_NO_RESPAWN': '1',
               'OPENCLAW_CONFIG_READONLY': '1', 'OPENCLAW_STATE_DIR': scratch,
               'OPENCLAW_CONFIG_PATH': str(pathlib.Path(scratch, 'openclaw.json'))}
        CURRENT_PHASE = 'plan'
        run_child(['/usr/local/bin/node', STAGE, 'plan', scratch, execution_id], env, scratch, pathlib.Path(scratch, 'plan-output'), deadline)
        plan = json.loads(pathlib.Path(scratch, 'plan.json').read_text())
        if len(plan['snapshots']) > 2:
            raise ValueError('store limit exceeded')
        CURRENT_PHASE = 'snapshot'
        for index, snapshot in enumerate(plan['snapshots']):
            run_child(['/usr/local/bin/openclaw', 'backup', 'sqlite', 'create', '--agent', snapshot['agentId'], '--repository', snapshot['repository'], '--json'], env, scratch, pathlib.Path(scratch, f'snapshot-{index}.json'), min(deadline, time.monotonic() + 180))
        CURRENT_PHASE = 'finish'
        run_child(['/usr/local/bin/node', STAGE, 'finish', scratch, execution_id], env, scratch, pathlib.Path(scratch, 'finish-output'), deadline)
        for line in pathlib.Path(scratch, 'finish-output').read_text().splitlines():
            if line.startswith('[codex-store-snapshot]'):
                print(line, file=sys.stderr, flush=True)
        transfer = json.loads(pathlib.Path(scratch, 'transfer.json').read_text())
        env['RSYNC_CONNECT_PROG'] = '/usr/bin/prlimit --as=536870912 --core=0 -- ' + transfer['connectProgram']
        CURRENT_PHASE = 'transfer'
        run_child(['/usr/bin/rsync', *transfer['args']], env, scratch, pathlib.Path(scratch, 'rsync-output'), deadline, 512 * MIB)
        request = json.loads(request_data)
        receipt = {k: request[k] for k in ['version', 'executionId', 'migrationId', 'sourcePodUid']}
        receipt['status'] = 'transferred'
        encoded = json.dumps(receipt)
        if len(encoded) > 1024:
            raise ValueError('receipt too large')
        pathlib.Path('/dev/termination-log').write_text(encoded)
        print(encoded, flush=True)
    finally:
        shutil.rmtree(scratch)


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print(f'source transfer failed phase={CURRENT_PHASE}', file=sys.stderr, flush=True)
        sys.exit(1)
