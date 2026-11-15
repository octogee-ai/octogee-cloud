import json
import time
from pathlib import Path

root = Path('/home/node/results')
cgroup = Path('/sys/fs/cgroup')
started = time.monotonic()
with (root / 'samples.jsonl').open('a', buffering=1) as output:
    while True:
        sample = {'elapsedSeconds': round(time.monotonic() - started, 3), 'unixSeconds': time.time()}
        sample['phase'] = (root / 'phase').read_text().strip() if (root / 'phase').exists() else 'startup'
        for name in ['memory.current', 'memory.peak', 'memory.events', 'cpu.stat', 'cpu.max']:
            try:
                sample[name] = (cgroup / name).read_text().strip()
            except OSError as error:
                sample[name] = {'error': str(error)}
        if not (cgroup / 'memory.current').exists():
            try:
                sample['memory.current'] = (cgroup / 'memory/memory.usage_in_bytes').read_text().strip()
                usage = int((cgroup / 'cpuacct/cpuacct.usage').read_text())
                sample['cpu.stat'] = f'usage_usec {usage // 1000}'
                sample['counterSource'] = 'gvisor-cgroup-v1; CPU excludes host sandbox overhead; throttling unavailable'
            except OSError as error:
                sample['v1Error'] = str(error)
        processes = []
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                fields = (proc / 'stat').read_text().split(') ', 1)[1].split()
                command = (proc / 'comm').read_text().strip()
                processes.append({'pid': int(proc.name), 'command': command, 'rssBytes': int(fields[21]) * 4096, 'cpuTicks': int(fields[11]) + int(fields[12])})
            except (OSError, ValueError, IndexError):
                continue
        sample['processes'] = processes
        output.write(json.dumps(sample) + '\n')
        time.sleep(1)
