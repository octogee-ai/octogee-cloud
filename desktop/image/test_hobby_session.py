import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SESSION = Path(__file__).parents[2] / 'gateway/hobby-session.sh'


@unittest.skipUnless(sys.platform == 'linux', 'production session requires Linux Bash 5')
class HobbySessionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.binary = self.root / 'bin'
        self.binary.mkdir()
        (self.root / 'runtime/octogee-openclaw-vnc').mkdir(parents=True)
        commands = ('Xvnc', 'openbox', 'octo-desktop-control', 'entrypoint.sh', 'octogee-desktop-node', 'octo-desktop-browser', 'tigervncpasswd', 'xdpyinfo', 'xsetroot', 'tint2', 'wmctrl')
        stub = '''
import os
from pathlib import Path
import signal
import sys
import time
root = Path(os.environ['OCTO_SESSION_TEST_ROOT'])
name = Path(sys.argv[0]).name
if name in ('xdpyinfo', 'xsetroot'):
    sys.exit(0)
if name == 'wmctrl':
    if (root / 'desk-window').exists():
        print('0x00600002  0 127.0.0.1__desk.Chromium  pod Desk')
    sys.exit(0)
if name == 'octo-desktop-browser' and os.environ.get('BROWSER_HANDOFF') == '1' and (root / 'launches-octo-desktop-browser').exists():
    with (root / 'launches-octo-desktop-browser').open('a') as f:
        f.write(str(os.getpid()) + '\\n')
    sys.exit(0)
if name == 'tigervncpasswd':
    sys.stdin.read()
    sys.stdout.write('encoded-password')
    sys.exit(0)
with (root / ('launches-' + name)).open('a') as f:
    f.write(str(os.getpid()) + '\\n')
(root / ('args-' + name)).write_text('\\n'.join(sys.argv[1:]))
if name == 'octo-desktop-control' and os.environ.get('EARLY_RESTART') == '1':
    os.kill(int(os.environ['OCTO_SUPERVISOR_PID']), signal.SIGUSR1)
while not (root / ('exit-' + name)).exists():
    time.sleep(0.01)
sys.exit(0)
'''
        for command in commands:
            path = self.binary / command
            path.write_text(f'#!{sys.executable}\n' + stub)
            path.chmod(0o755)
        self.script = self.root / 'session.sh'
        self.script.write_text(SESSION.read_text().replace('/usr/local/bin/', str(self.binary) + '/'))
        self.log = (self.root / 'log').open('w+')
        self.process = None

    def tearDown(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.log.close()
        self.directory.cleanup()

    def launch(self, early=False, handoff=False, grace='0'):
        env = {**os.environ, 'HOME': str(self.root), 'OCTO_SESSION_TEST_ROOT': str(self.root), 'PATH': f'{self.binary}:{os.environ["PATH"]}',
               'XDG_RUNTIME_DIR': str(self.root / 'runtime'), 'OPENCLAW_GATEWAY_TOKEN': 'test-gateway-token', 'EARLY_RESTART': '1' if early else '0',
               'OCTO_DESK_WATCH_INTERVAL': '0.05', 'OCTO_DESK_REOPEN_GRACE': grace, 'BROWSER_HANDOFF': '1' if handoff else '0'}
        self.process = subprocess.Popen(['bash', str(self.script)], env=env, stdout=self.log, stderr=self.log, start_new_session=True)
        self.await_condition(lambda: self.count('octo-desktop-browser') >= 1)
        self.await_condition(lambda: self.count('octogee-desktop-node') == 1)
        self.await_condition(lambda: self.count('tint2') == 1)

    def args(self, name):
        text = (self.root / ('args-' + name)).read_text()
        return text.split('\n') if text else []

    def count(self, name):
        path = self.root / ('launches-' + name)
        return len(path.read_text().splitlines()) if path.exists() else 0

    def await_condition(self, predicate):
        deadline = time.monotonic() + 5
        while not predicate():
            if time.monotonic() >= deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(0.01)

    def test_restarts_chromium_without_restarting_gateway_or_node(self):
        self.launch()
        self.process.send_signal(signal.SIGUSR1)
        self.await_condition(lambda: self.count('octo-desktop-browser') == 2)
        self.assertIsNone(self.process.poll())
        self.assertEqual(self.count('entrypoint.sh'), 1)
        self.assertEqual(self.count('octogee-desktop-node'), 1)
        password = self.root / 'runtime/octogee-openclaw-vnc/password'
        self.assertEqual(len(password.read_text().strip()), 8)
        self.assertEqual(password.stat().st_mode & 0o777, 0o600)

    def test_an_early_egress_signal_still_starts_a_browser(self):
        self.launch(early=True)
        self.assertIsNone(self.process.poll())

    def test_required_desktop_process_failure_restarts_the_container(self):
        self.launch()
        (self.root / 'exit-openbox').touch()
        self.assertEqual(self.process.wait(timeout=5), 1)
        self.log.seek(0)
        self.assertIn('required process', self.log.read())

    def test_closed_dock_is_relaunched_without_touching_the_browser(self):
        self.launch()
        self.await_condition(lambda: self.count('tint2') == 1)
        (self.root / 'exit-tint2').touch()
        self.await_condition(lambda: self.count('tint2') == 2)
        self.assertIsNone(self.process.poll())
        self.assertEqual(self.count('octo-desktop-browser'), 1)

    def test_openbox_runs_the_platform_configuration_and_the_browser_opens_the_desk(self):
        self.launch()
        self.assertEqual(self.args('openbox'), ['--config-file', '/usr/share/octogee/hobby-desktop/rc.xml'])
        self.assertEqual(self.args('tint2'), ['-c', '/usr/share/octogee/hobby-desktop/tint2rc'])
        self.assertEqual(self.args('octo-desktop-browser'), [])

    def test_closed_desk_window_is_reopened_in_the_running_browser_until_it_returns(self):
        (self.root / 'desk-window').touch()
        self.launch(handoff=True)
        time.sleep(0.3)
        self.assertEqual(self.count('octo-desktop-browser'), 1)
        (self.root / 'desk-window').unlink()
        self.await_condition(lambda: self.count('octo-desktop-browser') >= 3)
        (self.root / 'desk-window').touch()
        time.sleep(0.3)
        settled = self.count('octo-desktop-browser')
        time.sleep(0.3)
        self.assertEqual(self.count('octo-desktop-browser'), settled)
        self.assertIsNone(self.process.poll())
        self.assertEqual(self.count('entrypoint.sh'), 1)

    def test_a_slow_desk_reopen_does_not_block_required_process_supervision(self):
        self.launch()
        self.await_condition(lambda: self.count('octo-desktop-browser') == 2)
        (self.root / 'exit-openbox').touch()
        self.assertEqual(self.process.wait(timeout=5), 1)
        self.log.seek(0)
        self.assertIn('required process', self.log.read())

    def test_a_desk_missing_while_chromium_starts_is_not_reopened_before_the_grace_period(self):
        self.launch(handoff=True, grace='60')
        time.sleep(0.5)
        self.assertEqual(self.count('octo-desktop-browser'), 1)
        self.assertIsNone(self.process.poll())

    def test_closed_browser_is_relaunched(self):
        self.launch()
        (self.root / 'exit-octo-desktop-browser').touch()
        self.await_condition(lambda: self.count('octo-desktop-browser') >= 2)
        self.assertIsNone(self.process.poll())
