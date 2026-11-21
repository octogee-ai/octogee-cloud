import hashlib
import io
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


FETCH = Path(__file__).parents[1] / 'rootfs/usr/share/omarchy/octo-desktop/fetch-wlrctl.sh'
PRIMARY = 'https://primary.example/pool/wlrctl.orig.tar.gz'
ARCHIVE = 'https://archive.example/file/wlrctl-by-hash'
MOCK_CURL = '''#!/usr/bin/env python3
import os, shutil, sys
args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith('https://'))
with open(os.environ['FETCH_CALLS'], 'a') as log: log.write(url + '\\n')
served = os.path.join(os.environ['FETCH_SERVED'], url.rsplit('/', 1)[1])
if not os.path.exists(served):
    print('curl: (22) The requested URL returned error: 503', file=sys.stderr); sys.exit(22)
shutil.copyfile(served, args[args.index('-o') + 1])
'''


def release_archive():
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode='w:gz') as archive:
        for name, body in {'wlrctl-0.2.2/meson.build': b'project', 'wlrctl-0.2.2/protocol/virtual-keyboard-unstable-v1.xml': b'<protocol/>'}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(body)
            archive.addfile(entry, io.BytesIO(body))
    return payload.getvalue()


class WlrctlSourceTests(unittest.TestCase):
    def fetch(self, root, served):
        curl = root / 'bin/curl'
        curl.parent.mkdir()
        curl.write_text(MOCK_CURL)
        curl.chmod(0o755)
        release = release_archive()
        (root / 'served').mkdir()
        for name, body in served.items():
            (root / 'served' / name).write_bytes(release if body is None else body)
        result = subprocess.run(['bash', str(FETCH), str(root / 'wlrctl')],
            env={**os.environ, 'PATH': f'{root / "bin"}:{os.environ["PATH"]}', 'FETCH_CALLS': str(root / 'calls'), 'FETCH_SERVED': str(root / 'served'),
                 'WLRCTL_SHA256': hashlib.sha256(release).hexdigest(), 'WLRCTL_SOURCES': f'{PRIMARY} {ARCHIVE}'},
            capture_output=True, text=True, timeout=10)
        calls = (root / 'calls').read_text().splitlines() if (root / 'calls').exists() else []
        return result, calls

    def test_release_is_unpacked_from_the_first_source_that_serves_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, calls = self.fetch(root, {'wlrctl.orig.tar.gz': None, 'wlrctl-by-hash': None})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(calls, [PRIMARY])
            self.assertEqual((root / 'wlrctl/protocol/virtual-keyboard-unstable-v1.xml').read_text(), '<protocol/>')

    def test_unavailable_source_is_reported_and_the_next_one_is_used(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, calls = self.fetch(root, {'wlrctl-by-hash': None})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(calls, [PRIMARY, ARCHIVE])
            self.assertIn(f'wlrctl 0.2.2 was not accepted from {PRIMARY}', result.stderr)
            self.assertEqual((root / 'wlrctl/meson.build').read_text(), 'project')

    def test_archive_with_another_checksum_is_never_unpacked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, calls = self.fetch(root, {'wlrctl.orig.tar.gz': b'tampered', 'wlrctl-by-hash': b'tampered'})
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertEqual(calls, [PRIMARY, ARCHIVE])
            self.assertIn(f'wlrctl 0.2.2 was not accepted from {ARCHIVE}', result.stderr)
            self.assertIn('wlrctl 0.2.2 could not be fetched from any pinned source', result.stderr)
            self.assertFalse((root / 'wlrctl').exists())


if __name__ == '__main__':
    unittest.main()
