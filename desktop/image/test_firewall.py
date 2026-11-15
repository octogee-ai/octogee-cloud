import os
from pathlib import Path
import subprocess
import tempfile
import unittest

RUN = Path(__file__).parent / 'rootfs/usr/local/bin/octo-gateway-firewall'

class FirewallTests(unittest.TestCase):
    def test_allows_only_gateway_ports_from_cluster_pods(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock = root / 'ufw'
            mock.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$RECORD"\n')
            mock.chmod(0o755)
            record = root / 'calls'
            result = subprocess.run(['bash', str(RUN)], env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}', 'RECORD': str(record)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(record.read_text().splitlines(), [f'allow proto tcp from 10.117.0.0/17 to any port {port}' for port in (3001, 3003, 30873)])

    def test_stops_when_firewall_rule_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            mock = Path(directory) / 'ufw'
            mock.write_text('#!/bin/bash\nexit 23\n')
            mock.chmod(0o755)
            result = subprocess.run(['bash', str(RUN)], env={**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}'}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 23, result.stderr)

if __name__ == '__main__':
    unittest.main()
