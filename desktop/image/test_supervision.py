import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


RUN = Path(__file__).parents[1] / 'rootfs/usr/local/bin/octo-desktop-run'
SERVICES = ('labwc', 'octo-seat-input', 'wayvnc', 'octo-desktop-openclaw-vnc',
            'websockify', 'octo-desktop-control')
BROWSER = 'octo-desktop-browser'


class SessionHarness:
    def start_session(self, early_restart_signal=False, signal_during_launch=False, signal_after_exit=False):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        binary = self.root / 'bin'
        binary.mkdir()
        (self.root / '.local/state/octo-desktop').mkdir(parents=True)
        (self.root / 'pids').mkdir()
        (self.root / 'supervisors').mkdir()
        self.profile = self.root / '.config/octogee-chromium'
        self.profile.mkdir(parents=True)
        for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
            (self.profile / name).symlink_to('former-hobby-pod-24')
        (self.profile / 'Local State').write_text('retained browser state')
        stub = '''
import os
from pathlib import Path
import sys
import time
root = Path(os.environ['HOME'])
name = Path(sys.argv[0]).name
if name == 'wlr-randr':
    sys.exit(0)
if name == 'labwc':
    (root / 'wayland-0').touch()
if name == 'octo-seat-input':
    print('ready', flush=True)
if name == 'octo-desktop-control' and os.environ.get('OCTO_TEST_EARLY_RESTART') == '1':
    import signal
    os.kill(int(os.environ['OCTO_SUPERVISOR_PID']), signal.SIGUSR1)
pid_file = root / 'pids' / name
(root / 'supervisors' / name).write_text(os.environ.get('OCTO_SUPERVISOR_PID', ''))
pid_file.with_suffix('.pending').write_text(str(os.getpid()))
pid_file.with_suffix('.pending').replace(pid_file)
while not (root / ('exit-' + name)).exists():
    time.sleep(0.01)
sys.exit(int((root / ('exit-' + name)).read_text()))
'''
        for name in (*SERVICES, BROWSER, 'wlr-randr'):
            executable = binary / name
            executable.write_text(f'#!{sys.executable}\n' + stub)
            executable.chmod(0o755)
        script = self.root / 'run'
        source = RUN.read_text().replace('/usr/local/bin/', str(binary) + '/')
        if early_restart_signal:
            source = source.replace('\nlaunch_browser\n', '\nsleep 1\nlaunch_browser\n', 1)
        if signal_during_launch:
            marker = '    browser_pid=$!\n    stamp "chromium launched"\n'
            assert marker in source
            source = source.replace(marker, '    if [[ ! -e "$HOME/raced" ]]; then touch "$HOME/raced"; kill -USR1 $$; fi\n' + marker, 1)
            source = source.replace('\nlaunch_browser\n', '\nlaunch_browser\nsleep 1\n', 1)
        if signal_after_exit:
            marker = '    idle_browser\n    continue\n'
            assert marker in source
            source = source.replace(marker, f'    idle_browser\n    if [[ ! -e "$HOME/raced" ]]; then touch "$HOME/raced"; rm -f "$HOME/exit-{BROWSER}"; kill -USR1 $$; sleep 0.1; fi\n    continue\n', 1)
        script.write_text(source)
        self.log = (self.root / 'output').open('w+')
        self.addCleanup(self.log.close)
        self.process = subprocess.Popen(
            [os.environ.get('OCTOGEE_TEST_BASH', shutil.which('bash')), str(script)],
            env={**os.environ, 'HOME': str(self.root), 'XDG_RUNTIME_DIR': str(self.root),
                 'OCTO_COMPOSITOR': 'labwc', 'PATH': f'{binary}:{os.environ["PATH"]}',
                 'OCTO_TEST_EARLY_RESTART': '1' if early_restart_signal else '0'},
            stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        self.addCleanup(self.stop)
        self.wait_for(lambda: all((self.root / 'pids' / name).exists()
                                 for name in (*SERVICES, BROWSER)))

    def output(self):
        return (self.root / 'output').read_text()

    def wait_for(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail(self.output())

    def stop(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=3)

    def exit_child(self, name, status=0):
        exit_file = self.root / ('exit-' + name)
        pending = exit_file.with_suffix('.pending')
        pending.write_text(str(status))
        pending.replace(exit_file)

    def assert_services_running(self):
        self.assertIsNone(self.process.poll(), self.output())
        for name in SERVICES:
            os.kill(int((self.root / 'pids' / name).read_text()), 0)

    def assert_stopped(self):
        self.process.wait(timeout=5)
        for pid_file in (self.root / 'pids').iterdir():
            with self.assertRaises(ProcessLookupError, msg=pid_file.name):
                os.kill(int(pid_file.read_text()), 0)

    def browser_pid(self):
        return int((self.root / 'pids' / BROWSER).read_text())

    def alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True


class SupervisionTests(SessionHarness, unittest.TestCase):
    def setUp(self):
        self.start_session()

    def test_start_clears_prior_host_locks_and_preserves_browser_state(self):
        for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
            self.assertFalse((self.profile / name).is_symlink())
        self.assertEqual((self.profile / 'Local State').read_text(), 'retained browser state')

    def test_second_supervisor_leaves_the_running_browser_locks_intact(self):
        lock = self.profile / 'SingletonLock'
        lock.unlink(missing_ok=True)
        lock.symlink_to('current-host-1000')
        result = subprocess.run(
            [os.environ.get('OCTOGEE_TEST_BASH', shutil.which('bash')), str(self.root / 'run')],
            env={**os.environ, 'HOME': str(self.root), 'XDG_RUNTIME_DIR': str(self.root)},
            capture_output=True, text=True, timeout=2,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('desktop session already running', result.stderr)
        self.assertEqual(os.readlink(lock), 'current-host-1000')
        self.assert_services_running()

    def test_closing_chromium_preserves_the_desktop_services(self):
        self.exit_child(BROWSER)
        self.wait_for(lambda: 'Chromium exited (status=0)' in self.output() or self.process.poll() is not None)
        self.assert_services_running()
        self.assertIn('Chromium exited (status=0)', self.output())

    def test_chromium_crash_is_reported_without_stopping_the_desktop(self):
        self.exit_child(BROWSER, 17)
        self.wait_for(lambda: 'Chromium exited (status=17)' in self.output() or self.process.poll() is not None)
        self.assert_services_running()
        self.assertIn('Chromium exited (status=17)', self.output())

    def test_core_service_exit_stops_the_remaining_session(self):
        self.exit_child('wayvnc', 23)
        self.assert_stopped()
        self.assertIn('status=23', self.output())

    def test_core_service_exit_after_chromium_closed_still_stops_the_session(self):
        self.exit_child(BROWSER)
        self.wait_for(lambda: 'Chromium exited' in self.output() or self.process.poll() is not None)
        self.assert_services_running()
        self.exit_child('labwc', 23)
        self.assert_stopped()
        self.assertIn('status=23', self.output())

    def test_tells_the_control_api_which_supervisor_to_signal(self):
        self.assertEqual((self.root / 'supervisors' / 'octo-desktop-control').read_text(), str(self.process.pid))

    def test_restart_signal_relaunches_a_running_chromium_without_touching_the_desktop(self):
        first = self.browser_pid()
        os.kill(self.process.pid, signal.SIGUSR1)
        self.wait_for(lambda: self.browser_pid() != first and not self.alive(first))
        self.assertTrue(self.alive(self.browser_pid()))
        self.assert_services_running()
        self.assertIn('Chromium restarting for an egress mode change', self.output())

    def test_restart_signal_launches_chromium_again_after_the_user_closed_it(self):
        first = self.browser_pid()
        self.exit_child(BROWSER)
        self.wait_for(lambda: 'Chromium exited (status=0)' in self.output())
        (self.root / ('exit-' + BROWSER)).unlink()
        os.kill(self.process.pid, signal.SIGUSR1)
        self.wait_for(lambda: self.browser_pid() != first and self.alive(self.browser_pid()))
        self.assert_services_running()

    def test_session_stop_terminates_chromium_and_core_services(self):
        self.process.terminate()
        self.assert_stopped()



class EarlyRestartSignalTest(SessionHarness, unittest.TestCase):
    def setUp(self):
        self.start_session(early_restart_signal=True)

    def test_a_restart_request_before_the_first_launch_is_consumed_by_that_launch(self):
        first = self.browser_pid()
        self.exit_child(BROWSER)
        self.wait_for(lambda: 'Chromium exited (status=0)' in self.output() or 'restarting' in self.output())
        time.sleep(0.2)
        self.assertNotIn('Chromium restarting for an egress mode change', self.output())
        self.assertEqual(self.browser_pid(), first)
        self.assert_services_running()


class RestartDuringLaunchTest(SessionHarness, unittest.TestCase):
    def setUp(self):
        self.start_session(signal_during_launch=True)

    def test_a_restart_request_that_lands_while_chromium_is_launching_still_restarts_it(self):
        self.wait_for(lambda: 'Chromium restarting for an egress mode change' in self.output())
        self.wait_for(lambda: self.output().count('chromium launched') >= 2 and self.alive(self.browser_pid()))
        self.assert_services_running()


class RestartAfterExitTest(SessionHarness, unittest.TestCase):
    def setUp(self):
        self.start_session(signal_after_exit=True)

    def test_a_restart_request_right_after_chromium_closed_still_launches_it(self):
        first = self.browser_pid()
        self.exit_child(BROWSER)
        self.wait_for(lambda: self.browser_pid() != first and self.alive(self.browser_pid()))
        self.assert_services_running()


if __name__ == '__main__':
    unittest.main()
