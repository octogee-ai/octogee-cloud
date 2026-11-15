import os
from pathlib import Path
import subprocess
import tempfile
import unittest


MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, socket, struct, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
case = os.environ['ACCEPTANCE_CASE']
connection = pathlib.Path(os.environ['ACCEPTANCE_MARKER'] + '.connection')
if name == 'gcloud':
    if 'stop' in args and case == 'ssh-new-connection-timeout':
        assert not connection.exists(), 'SSH master must close before stopping the VM'
    if args[:3] == ['compute', 'instances', 'create']:
        ci = os.environ['OCTOGEE_IMAGE_RUN_ID'] != 'manual'
        assert ('--max-run-duration=2h' in args) == ci
        assert ('--instance-termination-action=DELETE' in args) == ci
        if case == 'zone-exhausted' and 'us-central1-a' in args:
            print('ERROR: (gcloud.compute.instances.create) Could not fetch resource:\ncode: ZONE_RESOURCE_POOL_EXHAUSTED', file=sys.stderr)
            sys.exit(1)
        if case == 'create-failed':
            print('ERROR: (gcloud.compute.instances.create) permission denied', file=sys.stderr)
            sys.exit(1)
    if 'describe' in args: assert '--zone' in args and args[args.index('--zone') + 1] == os.environ['ACCEPTANCE_EXPECTED_ZONE']
    if 'describe' in args: print('192.0.2.1')
elif name == 'scp':
    if case == 'ssh-new-connection-timeout':
        assert connection.exists() and 'ControlPath=' + connection.read_text() in args
    pathlib.Path(args[-1]).write_bytes(b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('>II', 1440, 900))
elif name == 'ssh':
    command = args[-1]
    if case == 'ssh-new-connection-timeout':
        control = next((arg.removeprefix('ControlPath=') for arg in args if arg.startswith('ControlPath=')), None)
        if '-O' in args and args[args.index('-O') + 1] == 'exit':
            pathlib.Path(connection.read_text()).unlink()
            connection.unlink()
            sys.exit(0)
        if connection.exists():
            if control != connection.read_text():
                print('ssh: connect to host port 22: Connection timed out', file=sys.stderr)
                sys.exit(255)
        else:
            connection.write_text(control or 'no-master')
            if control:
                assert 'ControlMaster=auto' in args
                master = socket.socket(socket.AF_UNIX)
                master.bind(control)
    if case == 'ssh-preload-timeout' and '/etc/octogee-gateway-image' in command:
        print('ssh: connect to host port 22: Connection timed out', file=sys.stderr)
        sys.exit(255)
    if command == 'bash -s':
        if case == 'no-accessibility':
            print('Chromium never registered on the accessibility bus', file=sys.stderr)
            sys.exit(1)
        print('accessibility bus unix:path=/run/user/1000/at-spi/bus_0 serves: Chromium')
    elif command == 'bash -s user-power':
        if case == 'user-power-broken':
            print('builder power: polkit still asks octo for a password', file=sys.stderr)
            sys.exit(1)
        print('builder power: sudo and polkit passwordless, boot entry enrolled under this machine id, keeps console and drops resume after regen, no first-run tips, Omarchy is up to date')
    elif command == 'bash -s familiar':
        if case == 'familiar-broken':
            print('familiar desktop: Chromium is not floating', file=sys.stderr)
            sys.exit(1)
        print('familiar desktop: hyprbars loaded, theme octogee on 1-quattro.jpg, omarchy round trip clean, idle 1.2%')
    elif command == 'bash -s desk':
        if case == 'desk-broken':
            print('desk: default note is: hello', file=sys.stderr)
            sys.exit(1)
        print('desk: app window chrome-127.0.0.1__desk-Default floating with no browser window, page served, default note, 9 apps with chromium + Nautilus, note round trip, launch validated, time zone round trip (America/Chicago), idle 95.6% with the Desk in front, Chromium policy homepage on "Desk"')
    elif command == 'python3 -':
        if case == 'missing-resize': sys.exit(22)
        if case == 'resize-lost-after-reboot' and pathlib.Path(os.environ['ACCEPTANCE_MARKER']).exists(): sys.exit(22)
        print('display resize verified: 1440x900')
    elif '/etc/octogee-gateway-edge-image' in command:
        if case == 'edge-cache-missing' or (case == 'edge-cache-lost-after-reboot' and pathlib.Path(os.environ['ACCEPTANCE_MARKER']).exists()): sys.exit(1)
        print('us-central1-docker.pkg.dev/octogee/octogee/gateway-edge@sha256:' + ('c' if case == 'edge-cache-wrong' else 'b') * 64)
    elif '/etc/octogee-computer.env' in command:
        if case == 'installed-version-mismatch': sys.exit(1)
        print('ISO=4.5.0 installed=4.5.0-2')
    elif '/etc/octogee-gateway-image' in command:
        if case == 'gateway-cache-missing' or (case == 'gateway-cache-lost-after-reboot' and pathlib.Path(os.environ['ACCEPTANCE_MARKER']).exists()): sys.exit(1)
        print('us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder@sha256:' + ('b' if case == 'gateway-cache-wrong' else 'a') * 64)
    elif 'cat /etc/octogee-computer-image' in command: print('fixture-image')
    elif 'systemd-analyze verify' in command:
        if case == 'nonexecutable-agent':
            print('octo-gateway-agent.service: Command is not executable', file=sys.stderr)
            sys.exit(1)
    elif 'systemd-analyze' in command: print('Startup finished in 1s')
    elif 'lsmod' in command: print(1 if case == 'missing-module' else 2)
    elif 'zram0' in command:
        if case == 'zram-missing': print('', '[lzo-rle]', 60, sep='\n')
        elif case == 'zram-untuned': print('/dev/zram0', 'lzo-rle lz4 [zstd]', 60, sep='\n')
        else: print('/swap/swapfile', '/dev/zram0', 'lzo-rle lzo lz4 lz4hc [zstd] deflate 842', 150, sep='\n')
    elif 'systemctl is-active' in command:
        states = ['active', 'failed' if case == 'inactive-unit' else 'active', 'active', 'active']
        if 'octo-gateway-agent.service' in command:
            states.append('failed' if case == 'inactive-agent' else 'active')
        print(' '.join(states))
    elif 'systemctl show octo-home-disk.service' in command:
        if case == 'home-disk-unmounted': print('exit-code')
        else: print('success\n/dev/sdb\n/dev/sdb[/desktop-home]')
    elif 'systemctl show octo-grow-root.service' in command: print('exit-code' if case == 'grow-root-failed' else 'success')
    elif 'systemctl show' in command: print(1 if case == 'desktop-restarted' else 0)
    elif '/health' in command: print(json.dumps({'clients': ['chrome-127.0.0.1__desk-Default']}))
    elif '/windows' in command: print(json.dumps([{'class': 'chrome-127.0.0.1__desk-Default', 'title': 'Desk'}]))
    elif command.startswith('echo persist-'):
        pathlib.Path(os.environ['ACCEPTANCE_MARKER']).write_text(command.split()[1])
    elif 'cat ~/persist-marker' in command:
        print(pathlib.Path(os.environ['ACCEPTANCE_MARKER']).read_text())
        if 'profile-present' in command and '.config/octogee-chromium/Default/Cookies' in command and case != 'missing-profile':
            print('profile-present')
'''


class ImageAcceptanceTests(unittest.TestCase):
    def run_acceptance(self, case, ci=False, expected_zone='us-central1-a', smoke=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('gcloud', 'scp', 'ssh'):
                path = root / name
                path.write_text(MOCK)
                path.chmod(0o755)
            result = subprocess.run(
                ['bash', str(Path(__file__).with_name('test.sh')), '--project', 'fixture', *(['--smoke'] if smoke else ['--stop-start']), '--zone', 'us-central1-a', '--fallback-zones', 'us-central1-b,us-central1-c'],
                env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}',
                     'ACCEPTANCE_CASE': case, 'OCTOGEE_IMAGE_RUN_ID': '123-1' if ci else 'manual', 'ACCEPTANCE_MARKER': str(root / 'marker'),
                     'ACCEPTANCE_EXPECTED_ZONE': expected_zone, 'OCTOGEE_DESKTOP_EDGE_IMAGE': 'us-central1-docker.pkg.dev/octogee/octogee/gateway-edge@sha256:' + 'b' * 64, 'OCTOGEE_DESKTOP_GATEWAY_IMAGE': 'us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder@sha256:' + 'a' * 64},
                capture_output=True, text=True, timeout=15,
            )
            if case == 'ssh-new-connection-timeout' and result.returncode == 0:
                self.assertFalse((root / 'marker.connection').exists(), 'SSH master must close on exit')
            return result

    def test_checks_reuse_ready_ssh_connection_and_reopen_after_restart(self):
        for smoke in (True, False):
            with self.subTest(smoke=smoke):
                result = self.run_acceptance('ssh-new-connection-timeout', smoke=smoke)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_ssh_failure_is_not_reported_as_missing_image(self):
        result = self.run_acceptance('ssh-preload-timeout', smoke=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Connection timed out', result.stderr)
        self.assertIn('could not verify gateway image preload', result.stderr)
        self.assertNotIn('preload is missing', result.stderr)

    def test_smoke_checks_boot_and_images_without_ui_or_restart_suite(self):
        for case in ['success', 'familiar-broken', 'missing-resize', 'missing-profile']:
            with self.subTest(case=case):
                result = self.run_acceptance(case, smoke=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('boot smoke passed', result.stdout)
                self.assertNotIn('Home survives stop/start', result.stdout)
        for case in ['inactive-unit', 'inactive-agent', 'edge-cache-missing', 'gateway-cache-wrong', 'installed-version-mismatch']:
            with self.subTest(case=case):
                result = self.run_acceptance(case, smoke=True)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_wrong_or_lost_edge_image_and_version_mismatch_fail_acceptance(self):
        for case in ['edge-cache-missing', 'edge-cache-wrong', 'edge-cache-lost-after-reboot', 'installed-version-mismatch']:
            with self.subTest(case=case):
                result = self.run_acceptance(case)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_current_browser_profile_survives_restart(self):
        result = self.run_acceptance('success')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Home survives stop/start | yes', result.stdout)
        self.assertIn('| zram swap | /dev/zram0, zstd, swappiness 150 |', result.stdout)
        self.assertIn('| Accessibility bus | accessibility bus unix:path=/run/user/1000/at-spi/bus_0 serves: Chromium |', result.stdout)

    def test_user_power_is_reported_and_its_failure_fails_acceptance(self):
        result = self.run_acceptance('success')
        self.assertIn('| Builder power (sudo, polkit, boot entry after regen, tips, updates) | builder power: sudo and polkit passwordless, boot entry enrolled under this machine id, keeps console and drops resume after regen, no first-run tips, Omarchy is up to date |', result.stdout)
        result = self.run_acceptance('user-power-broken')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('builder power acceptance failed', result.stderr)

    def test_familiar_desktop_is_reported_and_its_failure_fails_acceptance(self):
        result = self.run_acceptance('success')
        self.assertIn('| Familiar desktop | familiar desktop: hyprbars loaded, theme octogee on 1-quattro.jpg, omarchy round trip clean, idle 1.2% |', result.stdout)
        result = self.run_acceptance('familiar-broken')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('familiar desktop acceptance failed', result.stderr)

    def test_desk_is_reported_and_its_failure_fails_acceptance(self):
        result = self.run_acceptance('success')
        self.assertIn('| Desk | desk: app window chrome-127.0.0.1__desk-Default floating with no browser window, page served, default note, 9 apps with chromium + Nautilus, note round trip, launch validated, time zone round trip (America/Chicago), idle 95.6% with the Desk in front, Chromium policy homepage on "Desk" |', result.stdout)
        result = self.run_acceptance('desk-broken')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('desk acceptance failed', result.stderr)

    def test_desktop_without_chromium_on_the_accessibility_bus_fails_acceptance(self):
        result = self.run_acceptance('no-accessibility')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('desktop accessibility bus does not serve Chromium', result.stderr)

    def test_ci_vm_has_independent_cloud_deletion_deadline(self):
        result = self.run_acceptance('success', ci=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_exhausted_zone_falls_back_and_addresses_the_vm_there(self):
        result = self.run_acceptance('zone-exhausted', expected_zone='us-central1-b')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('zone us-central1-a has no capacity', result.stderr)
        self.assertIn('| Zone | us-central1-b |', result.stdout)

    def test_non_capacity_create_failure_does_not_fall_back(self):
        result = self.run_acceptance('create-failed')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('permission denied', result.stderr)
        self.assertNotIn('trying the next zone', result.stderr)

    def test_missing_resize_api_fails_acceptance(self):
        result = self.run_acceptance('missing-resize')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_resize_must_survive_restart(self):
        result = self.run_acceptance('resize-lost-after-reboot')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_profile_fails_acceptance(self):
        result = self.run_acceptance('missing-profile')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_drm_module_fails_acceptance(self):
        result = self.run_acceptance('missing-module')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_zram_swap_fails_acceptance(self):
        result = self.run_acceptance('zram-missing')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('zram swap is not configured', result.stderr)

    def test_zram_without_zram_tuned_reclaim_fails_acceptance(self):
        result = self.run_acceptance('zram-untuned')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('zram swap is not configured', result.stderr)

    def test_failed_unit_fails_acceptance(self):
        result = self.run_acceptance('inactive-unit')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_failed_root_growth_fails_acceptance(self):
        result = self.run_acceptance('grow-root-failed')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('octo-grow-root did not succeed: exit-code', result.stderr)

    def test_unmounted_home_disk_fails_acceptance(self):
        result = self.run_acceptance('home-disk-unmounted')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('octo-home-disk did not mount the home disk: exit-code', result.stderr)

    def test_boot_that_requires_service_restart_fails_acceptance(self):
        result = self.run_acceptance('desktop-restarted')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_nonexecutable_registration_agent_fails_acceptance(self):
        result = self.run_acceptance('nonexecutable-agent')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_inactive_registration_agent_fails_acceptance(self):
        result = self.run_acceptance('inactive-agent')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_gateway_cache_must_contain_the_exact_digest_before_boot_and_after_restart(self):
        for case in ('gateway-cache-missing', 'gateway-cache-wrong', 'gateway-cache-lost-after-reboot'):
            with self.subTest(case=case):
                result = self.run_acceptance(case)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('gateway image preload', result.stderr)


if __name__ == '__main__':
    unittest.main()
