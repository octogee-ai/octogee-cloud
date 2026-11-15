import json
import math
import sys
from collections import defaultdict
from pathlib import Path


def percentile(values, quantile):
    values = sorted(values)
    return values[min(len(values) - 1, math.ceil(len(values) * quantile) - 1)]


samples = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
phases = defaultdict(list)
for sample in samples:
    phases[sample['phase']].append(sample)
summary = {}
for phase, entries in phases.items():
    memory = [int(entry['memory.current']) / 1024 ** 2 for entry in entries if isinstance(entry.get('memory.current'), str)]
    cpu = []
    throttled = []
    for previous, current in zip(entries, entries[1:]):
        if not isinstance(previous.get('cpu.stat'), str) or not isinstance(current.get('cpu.stat'), str):
            continue
        before = {key: int(value) for key, value in (line.split() for line in previous['cpu.stat'].splitlines())}
        after = {key: int(value) for key, value in (line.split() for line in current['cpu.stat'].splitlines())}
        duration = current['unixSeconds'] - previous['unixSeconds']
        if duration <= 0 or duration > 5:
            continue
        if 'usage_usec' in before:
            cpu.append((after['usage_usec'] - before['usage_usec']) / 1000000 / duration)
        if 'nr_periods' in before and after['nr_periods'] > before['nr_periods']:
            throttled.append((after['nr_throttled'] - before['nr_throttled']) / (after['nr_periods'] - before['nr_periods']))
    result = {'samples': len(entries), 'sampledSeconds': len(entries), 'elapsedSpanSeconds': round(entries[-1]['unixSeconds'] - entries[0]['unixSeconds'], 1)}
    if memory:
        result.update(memoryMiB_p50=round(percentile(memory, .5), 1), memoryMiB_p95=round(percentile(memory, .95), 1), memoryMiB_max=round(max(memory), 1))
    else:
        result['memoryError'] = entries[0].get('memory.current')
    if cpu:
        result.update(guestCpuCores_mean=round(sum(cpu) / len(cpu), 3), guestCpuCores_p95=round(percentile(cpu, .95), 3))
    if throttled:
        result['throttledPeriodsFraction_mean'] = round(sum(throttled) / len(throttled), 3)
    summary[phase] = result
print(json.dumps(summary, indent=2))
