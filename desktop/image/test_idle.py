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


if __name__ == '__main__':
    unittest.main()
