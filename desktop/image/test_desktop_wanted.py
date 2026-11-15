import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parent / 'rootfs/usr/local/bin/octo-desktop-wanted'
FAKE_CURL = f'''#!{sys.executable}
import os, sys
from pathlib import Path
answers = Path(os.environ['FAKE_CURL_ANSWERS'])
lines = answers.read_text().splitlines()
answer, rest = lines[0], lines[1:] or lines[:1]
answers.write_text('\\n'.join(rest) + '\\n')
exit_code, status, body = answer.split(':', 2)
assert 'Metadata-Flavor: Google' in sys.argv
assert sys.argv[-1].endswith('/instance/attributes/octogee-computer-desktop')
if exit_code != '0':
    print('curl: (7) Failed to connect', file=sys.stderr)
    sys.exit(int(exit_code))
print(body, end='')
print('\\n' + status, end='')
'''


class DesktopWantedTests(unittest.TestCase):
    def run_script(self, *answers):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            curl = root / 'curl'
            curl.write_text(FAKE_CURL)
            curl.chmod(0o755)
            (root / 'answers').write_text('\n'.join(answers) + '\n')
            return subprocess.run(
                ['bash', str(SCRIPT)],
                env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}', 'FAKE_CURL_ANSWERS': str(root / 'answers'),
                     'OCTO_DESKTOP_WANTED_ATTEMPTS': '3', 'OCTO_DESKTOP_WANTED_RETRY_SECONDS': '0'},
                capture_output=True, text=True, timeout=15,
            )

    def test_starts_the_host_desktop_when_the_vm_names_no_desktop(self):
        self.assertEqual(self.run_script('0:404:not found').returncode, 0)

    def test_starts_the_host_desktop_for_an_omarchy_vm(self):
        self.assertEqual(self.run_script('0:200:omarchy').returncode, 0)

    def test_skips_the_host_desktop_for_an_x11_vm(self):
        result = self.run_script('0:200:x11')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('host desktop stays off', result.stdout)

    def test_waits_out_a_metadata_server_that_is_not_up_yet(self):
        self.assertEqual(self.run_script('7:000:', '0:200:x11').returncode, 1)

    def test_fails_the_unit_when_the_metadata_server_never_answers(self):
        result = self.run_script('7:000:')
        self.assertEqual(result.returncode, 255)
        self.assertIn('metadata server unreachable', result.stderr)

    def test_fails_the_unit_for_an_unknown_desktop(self):
        result = self.run_script('0:200:kde')
        self.assertEqual(result.returncode, 255)
        self.assertIn('unexpected octogee-computer-desktop', result.stderr)

    def test_fails_the_unit_for_a_metadata_server_error(self):
        result = self.run_script('0:500:boom')
        self.assertEqual(result.returncode, 255)


if __name__ == '__main__':
    unittest.main()
