import os
from pathlib import Path
import subprocess
import socket
import sys
import threading
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'rootfs/usr/local/bin/octo-desktop-openclaw-vnc'

class OpenClawVncTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'Linux Desktop runtime storage')
    def test_refuses_a_disk_backed_runtime(self):
        with tempfile.TemporaryDirectory(dir='/var/tmp') as directory:
            filesystem = subprocess.check_output(['findmnt', '-n', '-o', 'FSTYPE', '--target', directory], text=True).strip()
            if filesystem == 'tmpfs':
                self.skipTest('/var/tmp is already backed by tmpfs')
            result = subprocess.run(['python3', str(SCRIPT)], env={**os.environ, 'XDG_RUNTIME_DIR': directory}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('VNC runtime must be backed by tmpfs', result.stderr)
            self.assertFalse((Path(directory) / 'octogee-openclaw-vnc').exists())

    def test_starts_authenticated_loopback_listener_and_rotates_private_password(self):
        tmp = '/dev/shm' if sys.platform == 'linux' else None
        with tempfile.TemporaryDirectory(dir=tmp) as directory, tempfile.TemporaryDirectory() as bin_directory, socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            ready = threading.Timer(0.15, listener.listen)
            ready.start()
            port = listener.getsockname()[1]
            root = Path(directory)
            binary = Path(bin_directory)
            wayvnc = binary / 'x11vnc'
            wayvnc.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            wayvnc.chmod(0o755)
            env = {**os.environ, 'XDG_RUNTIME_DIR': directory, 'OCTO_VNC_PORT': str(port), 'PATH': f'{binary}:{os.environ["PATH"]}'}
            result = subprocess.run(['python3', str(SCRIPT)], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            state = root / 'octogee-openclaw-vnc'
            password = (state / 'password').read_text().strip()
            self.assertEqual(len(password), 8)
            self.assertEqual((state / 'password').stat().st_mode & 0o777, 0o600)
            self.assertEqual(state.stat().st_mode & 0o777, 0o700)
            for argument in [f'-reflect\n127.0.0.1:{port}', '-listen\n127.0.0.1', '-rfbport\n5901', '-passwdfile\n' + str(state / 'password')]:
                self.assertIn(argument, result.stdout)
            self.assertNotIn(password, result.stdout + result.stderr)
            previous = root / 'previous-password'
            previous.write_text('unchanged\n')
            (state / 'password').unlink()
            (state / 'password').symlink_to(previous)
            subprocess.run(['python3', str(SCRIPT)], env=env, check=True, capture_output=True)
            self.assertEqual(previous.read_text(), 'unchanged\n')
            self.assertFalse((state / 'password').is_symlink())
            self.assertEqual((state / 'password').stat().st_mode & 0o777, 0o600)
            self.assertNotEqual((state / 'password').read_text().strip(), password)

if __name__ == '__main__':
    unittest.main()
