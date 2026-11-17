import os
from pathlib import Path
import subprocess
import tempfile
import unittest


RUN = Path(__file__).parents[1] / 'rootfs/usr/local/bin/octo-desktop-run'


class IdleTests(unittest.TestCase):
    def test_disables_idle_before_starting_compositor_for_fresh_and_restored_homes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.local/state/octo-desktop').mkdir(parents=True)
            marker = root / '.local/state/omarchy/indicators/stay-awake'
            binary = root / 'bin'
            binary.mkdir()
            for name, body in {
                'start-hyprland': 'test -f "$HOME/.local/state/omarchy/indicators/stay-awake" && touch "$HOME/observed-awake"\nexit 1',
                'hyprctl': 'exit 1',
            }.items():
                path = binary / name
                path.write_text('#!/bin/bash\n' + body + '\n')
                path.chmod(0o755)
            for restored in (False, True):
                with self.subTest(restored=restored):
                    if restored:
                        marker.unlink(missing_ok=True)
                        (root / 'observed-awake').unlink(missing_ok=True)
                    result = subprocess.run(
                        ['bash', str(RUN)],
                        env={**os.environ, 'HOME': str(root), 'XDG_RUNTIME_DIR': str(root),
                             'PATH': f'{binary}:{os.environ["PATH"]}'},
                        capture_output=True, text=True, timeout=10,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue((root / 'observed-awake').is_file(), result.stdout + result.stderr)


class SuspendLockTests(unittest.TestCase):
    def test_managed_stay_awake_skips_suspend_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / 'omarchy-system-sleep-lock'
            vendor.write_text(
                '#!/bin/bash\n'
                '# omarchy:hidden=true\n\n'
                'request_lock() { touch "$HOME/locked"; }\n'
                'sync_clamshell() { :; }\n'
                'request_lock\n'
                'sync_clamshell\n'
            )
            vendor.chmod(0o755)
            marker = root / '.local/state/omarchy/indicators/stay-awake'
            marker.parent.mkdir(parents=True)
            marker.touch()

            customize = Path(__file__).with_name('customize.sh').read_text()
            functions = customize.split('\nlog "packages"', 1)[0]
            script = root / 'customize.sh'
            script.write_text(functions + '\nconfigure_omarchy_suspend_lock "$1"\n'
                              'configure_omarchy_suspend_lock "$1"\n')
            result = subprocess.run(
                ['bash', str(script), str(vendor)],
                env={**os.environ, 'OMARCHY_VERSION': 'fixture', 'IMAGE_NAME': 'fixture'},
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(vendor.stat().st_mode & 0o777, 0o755)

            for compositor, display, stay_awake in (
                ('hyprland', 'drm', True),
                ('hyprland', 'drm', False),
                ('hyprland', 'headless', True),
            ):
                with self.subTest(compositor=compositor, display=display, stay_awake=stay_awake):
                    if stay_awake:
                        marker.touch()
                    else:
                        marker.unlink(missing_ok=True)
                    lock = root / 'locked'
                    lock.unlink(missing_ok=True)
                    result = subprocess.run(
                        [str(vendor)], capture_output=True, text=True, timeout=5,
                        env={**os.environ, 'HOME': str(root), 'OCTO_COMPOSITOR': compositor,
                             'OCTO_DISPLAY': display},
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(lock.exists(), not (display == 'drm' and stay_awake))


if __name__ == '__main__':
    unittest.main()
