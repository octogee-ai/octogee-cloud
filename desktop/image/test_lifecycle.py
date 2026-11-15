from pathlib import Path
from unittest import mock
import io
import json
import runpy
import subprocess
import tempfile
import types
import unittest


DESKTOP = 'octo-desktop.service'
USER = 'user@1000.service'
MIGRATE = 'octo-home-migrate.service'
SSH = 'sshd.service'
LIFECYCLE = runpy.run_path(str(Path(__file__).parent / 'rootfs/usr/local/bin/octo-desktop-lifecycle'))
OPERATE = LIFECYCLE['operate']


class Systemd:
    def __init__(self):
        self.calls = []
        self.active = {DESKTOP: True, USER: True, MIGRATE: True, SSH: True}
        self.frozen = set()
        self.masked = False
        self.fail = []
        self.fail_after = []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        if argv in self.fail:
            self.fail.remove(argv)
            raise subprocess.CalledProcessError(1, argv, stderr='fixture failure')
        if argv[0] == 'sync':
            return types.SimpleNamespace(stdout='', returncode=0)
        action = argv[1]
        unit = argv[-1]
        if action == 'thaw' and unit == USER and self.masked:
            raise subprocess.CalledProcessError(1, argv, stderr='Unit user@1000.service is masked')
        output = ''
        if action == 'show':
            units = [value for value in argv[2:] if value.endswith('.service')]
            output = '\n'.join(('active' if self.active[name] else 'inactive') for name in units) if '--property=ActiveState' in argv else ('frozen' if unit in self.frozen else 'running')
        elif action == 'is-enabled':
            output = 'masked-runtime' if self.masked else 'static'
        elif action == 'mask': self.masked = True
        elif action == 'unmask': self.masked = False
        elif action == 'freeze': self.frozen.add(unit)
        elif action == 'thaw': self.frozen.discard(unit)
        elif action == 'stop': self.active[unit] = False
        elif action == 'start': self.active[unit] = True
        if argv in self.fail_after:
            self.fail_after.remove(argv)
            raise subprocess.CalledProcessError(1, argv, stderr='fixture reply lost after applying action')
        return types.SimpleNamespace(stdout=output, returncode=0)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.gate = Path(self.root.name) / 'home-restore.gate'

    def tearDown(self):
        self.root.cleanup()

    def operate(self, action, systemd, processes=lambda _uid: []):
        return OPERATE(action, systemd, gate=str(self.gate), processes=processes)

    def fresh_boot(self):
        self.gate.touch()
        systemd = Systemd()
        systemd.active = {DESKTOP: False, USER: False, MIGRATE: False, SSH: False}
        return systemd

    def test_full_home_restore_refuses_unfenced_ssh_writers_without_mutations(self):
        systemd = Systemd()
        with self.assertRaisesRegex(RuntimeError, 'SSH session writers'):
            self.operate('stop-home', systemd)
        self.assertEqual(systemd.calls, [])

    def test_installed_lifecycle_reads_the_gate_octo_home_disk_creates(self):
        self.assertEqual(LIFECYCLE['GATE'], '/srv/octogee/home-restore.gate')
        units = Path(__file__).parent / 'rootfs/etc/systemd/system'
        for unit in ('user@1000.service.d/10-octogee-home.conf', 'sshd.service.d/10-octogee-home-authorization.conf', 'octo-home-migrate.service', 'octo-desktop.service'):
            with self.subTest(unit=unit):
                self.assertIn(f'ConditionPathExists=!{LIFECYCLE["GATE"]}', (units / unit).read_text())

    def test_fresh_home_restore_proceeds_only_while_the_gate_kept_every_writer_off(self):
        systemd = self.fresh_boot()
        self.operate('stop-home', systemd)
        self.assertEqual(systemd.calls, [['systemctl', 'show', '--property=ActiveState', '--value', DESKTOP, USER, SSH]])
        self.assertFalse(any(systemd.active.values()))
        self.assertFalse(systemd.masked)

    def test_fresh_home_restore_refuses_a_running_writer_or_user_process_without_mutations(self):
        for writer in (DESKTOP, USER, SSH, None):
            with self.subTest(writer=writer):
                systemd = self.fresh_boot()
                if writer: systemd.active[writer] = True
                with self.assertRaisesRegex(RuntimeError, 'writers'):
                    self.operate('stop-home', systemd, processes=(lambda uid: [42] if uid == 1000 else []) if writer is None else (lambda _uid: []))
                self.assertEqual([argv[1] for argv in systemd.calls], ['show'])

    def test_start_keeps_writers_off_while_the_restore_gate_is_closed(self):
        systemd = self.fresh_boot()
        with self.assertRaisesRegex(RuntimeError, 'checkpoint restore'):
            self.operate('start', systemd)
        self.assertEqual(systemd.calls, [])
        self.assertFalse(any(systemd.active.values()))

    def test_start_after_the_gate_clears_admits_user_manager_then_migration_then_desktop_and_ssh(self):
        systemd = self.fresh_boot()
        self.gate.unlink()
        self.operate('start', systemd)
        self.assertTrue(all(systemd.active.values()))
        starts = [argv for argv in systemd.calls if argv[1] == 'start']
        self.assertEqual(starts, [['systemctl', 'start', USER], ['systemctl', 'start', MIGRATE], ['systemctl', 'start', DESKTOP], ['systemctl', 'start', '--no-block', SSH]])

    def test_a_failed_user_manager_migration_or_desktop_keeps_the_desktop_off_but_still_admits_ssh(self):
        for failing in (USER, MIGRATE, DESKTOP):
            with self.subTest(failing=failing):
                systemd = self.fresh_boot()
                self.gate.unlink()
                systemd.fail = [['systemctl', 'start', failing]]
                with self.assertRaises(subprocess.CalledProcessError) as raised:
                    self.operate('start', systemd)
                self.assertEqual(raised.exception.cmd, ['systemctl', 'start', failing])
                self.assertFalse(systemd.active[DESKTOP])
                self.assertTrue(systemd.active[SSH])
                self.assertEqual(systemd.calls[-1], ['systemctl', 'start', '--no-block', SSH])
                self.operate('start', systemd)
                self.assertTrue(all(systemd.active.values()))

    def test_ssh_admission_failure_after_a_failed_migration_reports_both(self):
        systemd = self.fresh_boot()
        self.gate.unlink()
        systemd.fail = [['systemctl', 'start', MIGRATE], ['systemctl', 'start', '--no-block', SSH]]
        with self.assertRaisesRegex(RuntimeError, rf"{MIGRATE}.*SSH admission also failed.*{SSH}"):
            self.operate('start', systemd)

    def test_owner_processes_skip_processes_that_exit_while_listed(self):
        class Process:
            def __init__(self, pid, failure=None): self.name, self.failure = str(pid), failure
            def stat(self): return types.SimpleNamespace(st_uid=1000)
            def __truediv__(self, _name):
                def read_text():
                    if self.failure: raise self.failure
                    return f'{self.name} (writer) S 1 {self.name} {self.name} 0'
                return types.SimpleNamespace(read_text=read_text)
        entries = [Process(20, ProcessLookupError(3, 'No such process')), Process(21, FileNotFoundError(2, 'gone')), Process(22)]
        with mock.patch.dict(LIFECYCLE['owner_processes'].__globals__, {'Path': lambda _path: types.SimpleNamespace(iterdir=lambda: entries)}):
            self.assertEqual(LIFECYCLE['owner_processes'](1000), [22])

    def test_control_answers_an_os_error_instead_of_dropping_the_request(self):
        handler = object.__new__(LIFECYCLE['Handler'])
        handler.path = '/stop-home'
        handler.wfile = io.BytesIO()
        sent = []
        handler.send_response = sent.append
        handler.send_header = lambda *_args: None
        handler.end_headers = lambda: None
        handler.log_message = lambda *_args: None
        def vanished(_action): raise PermissionError(13, 'Permission denied', '/proc/42/stat')
        with mock.patch.dict(LIFECYCLE['Handler'].do_POST.__globals__, {'operate': vanished}):
            handler.do_POST()
        self.assertEqual(sent, [500])
        self.assertIn('Permission denied', json.loads(handler.wfile.getvalue())['error'])

    def test_an_agent_restart_never_depends_on_the_migration_succeeding(self):
        agent = (Path(__file__).parent / 'rootfs/etc/systemd/system/octo-gateway-agent.service').read_text()
        directives = dict(line.split('=', 1) for line in agent.splitlines() if '=' in line and not line.startswith('#'))
        self.assertNotIn(MIGRATE, directives.get('Requires', '').split())
        self.assertIn(MIGRATE, directives['Wants'].split())
        self.assertIn(MIGRATE, directives['After'].split())

    def test_freezes_desktop_and_user_apps_before_sync(self):
        systemd = Systemd()
        self.operate('freeze', systemd)
        self.assertEqual(systemd.frozen, {DESKTOP, USER})
        self.assertEqual(systemd.calls[-1], ['sync', '-f', '/home/octo'])

    def test_partial_freeze_failure_thaws_only_newly_frozen_units(self):
        for already_frozen in (False, True):
            with self.subTest(already_frozen=already_frozen):
                systemd = Systemd()
                if already_frozen: systemd.frozen.add(DESKTOP)
                systemd.fail = [['systemctl', 'freeze', USER]]
                with self.assertRaises(subprocess.CalledProcessError): self.operate('freeze', systemd)
                self.assertEqual(systemd.frozen, {DESKTOP} if already_frozen else set())

    def test_sync_failure_rolls_back_both_new_freezes(self):
        systemd = Systemd()
        systemd.fail = [['sync', '-f', '/home/octo']]
        with self.assertRaises(subprocess.CalledProcessError): self.operate('freeze', systemd)
        self.assertFalse(systemd.frozen)

    def test_freeze_that_applies_before_reporting_failure_is_rolled_back(self):
        systemd = Systemd()
        systemd.fail_after = [['systemctl', 'freeze', USER]]
        with self.assertRaises(subprocess.CalledProcessError): self.operate('freeze', systemd)
        self.assertFalse(systemd.frozen)

    def test_rollback_failure_is_reported(self):
        systemd = Systemd()
        systemd.fail = [['sync', '-f', '/home/octo'], ['systemctl', 'thaw', USER]]
        with self.assertRaisesRegex(RuntimeError, 'rollback'): self.operate('freeze', systemd)
        self.assertNotIn(DESKTOP, systemd.frozen)

    def test_thaw_failure_still_attempts_other_scope(self):
        systemd = Systemd()
        systemd.frozen.update((DESKTOP, USER))
        systemd.fail = [['systemctl', 'thaw', USER]]
        with self.assertRaises(subprocess.CalledProcessError): self.operate('thaw', systemd)
        self.assertNotIn(DESKTOP, systemd.frozen)

    def test_frozen_stop_holds_user_manager_until_explicit_start(self):
        systemd = Systemd()
        self.operate('freeze', systemd)
        self.operate('stop', systemd)
        self.assertFalse(systemd.active[DESKTOP] or systemd.active[USER])
        self.assertTrue(systemd.masked)
        self.assertFalse(systemd.frozen)
        self.assertLess(systemd.calls.index(['systemctl', 'mask', '--runtime', USER]), systemd.calls.index(['systemctl', 'stop', USER]))
        self.operate('start', systemd)
        self.assertFalse(systemd.masked)
        self.assertTrue(all(systemd.active.values()))
        self.assertEqual(systemd.calls[-4:], [['systemctl', 'start', USER], ['systemctl', 'start', MIGRATE], ['systemctl', 'start', DESKTOP], ['systemctl', 'start', '--no-block', SSH]])

    def test_failed_stop_releases_new_mask_and_explicit_start_recovers(self):
        systemd = Systemd()
        systemd.fail = [['systemctl', 'stop', USER]]
        with self.assertRaises(subprocess.CalledProcessError): self.operate('stop', systemd)
        self.assertFalse(systemd.masked)
        self.operate('start', systemd)
        self.assertTrue(all(systemd.active.values()))

    def test_failed_stop_preserves_existing_restore_hold(self):
        systemd = Systemd()
        systemd.masked = True
        systemd.fail = [['systemctl', 'stop', USER]]
        with self.assertRaises(subprocess.CalledProcessError): self.operate('stop', systemd)
        self.assertTrue(systemd.masked)

    def test_mask_applied_before_reporting_failure_is_removed(self):
        systemd = Systemd()
        systemd.fail_after = [['systemctl', 'mask', '--runtime', USER]]
        with self.assertRaises(subprocess.CalledProcessError): self.operate('stop', systemd)
        self.assertFalse(systemd.masked)

    def test_start_recovers_an_active_frozen_user_manager(self):
        systemd = Systemd()
        systemd.masked = True
        systemd.frozen.update((DESKTOP, USER))
        self.operate('start', systemd)
        self.assertFalse(systemd.frozen)
        self.assertTrue(all(systemd.active.values()))

    def test_inactive_units_and_unknown_actions(self):
        systemd = Systemd()
        systemd.active = {DESKTOP: False, USER: False}
        self.operate('freeze', systemd)
        self.assertFalse(systemd.frozen)
        with self.assertRaises(ValueError): self.operate('exec', systemd)


if __name__ == '__main__':
    unittest.main()
