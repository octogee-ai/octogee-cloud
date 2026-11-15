import argparse
import json
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--context', required=True)
parser.add_argument('--namespace', required=True)
parser.add_argument('--pod', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--seconds', type=int, default=180)
args = parser.parse_args()
endpoint = f'/apis/metrics.k8s.io/v1beta1/namespaces/{args.namespace}/pods/{args.pod}'
deadline = time.monotonic() + args.seconds
with Path(args.output).open('a', buffering=1) as output:
    while time.monotonic() < deadline:
        result = subprocess.run(['kubectl', '--context', args.context, 'get', '--raw', endpoint], text=True, capture_output=True, timeout=20)
        sample = {'unixSeconds': time.time()}
        if result.returncode:
            sample['error'] = result.stderr.strip()
        else:
            data = json.loads(result.stdout)
            sample.update(timestamp=data['timestamp'], window=data['window'], containers=data['containers'])
        output.write(json.dumps(sample) + '\n')
        time.sleep(10)
