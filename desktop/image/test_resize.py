import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
import io
from types import SimpleNamespace
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('desktop_control', str(Path(__file__).parents[1] / 'rootfs/usr/local/bin/octo-desktop-control'))
spec = importlib.util.spec_from_loader(loader.name, loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)

class ResizeTest(unittest.TestCase):
    def test_x11_creates_a_virtual_mode_for_an_arbitrary_pane_size(self):
        initial = b'VNC-0 connected 1440x900+0+0\n   1440x900 60.00*+\n'
        applied = b'VNC-0 connected 1327x763+0+0\n   octogee-1327x763 60.00*\n'
        ok = SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
        with patch.object(control, 'COMPOSITOR', 'openbox'), patch.object(control, 'run', side_effect=[
            SimpleNamespace(returncode=0, stdout=initial, stderr=b''), ok, ok, ok,
            SimpleNamespace(returncode=0, stdout=applied, stderr=b''),
        ]) as run:
            self.assertEqual(control.resize(1327, 763), {'width': 1327, 'height': 763})
            self.assertEqual(run.call_args_list[1].args[0][:3], ['xrandr', '--newmode', 'octogee-1327x763'])
            self.assertIn(['xrandr', '--addmode', 'VNC-0', 'octogee-1327x763'], [c.args[0] for c in run.call_args_list])

    def test_x11_resize_uses_randr_and_checks_the_applied_geometry(self):
        with patch.object(control, 'COMPOSITOR', 'openbox'), patch.object(control, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b'Screen 0: minimum 32 x 32, current 800 x 600, maximum 32768 x 32768\nVNC-0 connected 800x600+0+0\n   800x600 60.00*+\n'
            self.assertEqual(control.resize(800, 600), {'width': 800, 'height': 600})
            self.assertIn(['xrandr', '--output', 'VNC-0', '--mode', '800x600'], [c.args[0] for c in run.call_args_list])

    def test_x11_reuses_the_current_virtual_mode_and_removes_obsolete_modes(self):
        geometry = b'VNC-0 connected 1327x763+0+0\n   octogee-1327x763 60.00*\n   octogee-900x700 60.00\n'
        with patch.object(control, 'COMPOSITOR', 'openbox'), patch.object(control, 'run', return_value=SimpleNamespace(returncode=0, stdout=geometry, stderr=b'')) as run:
            self.assertEqual(control.resize(1327, 763), {'width': 1327, 'height': 763})
            commands = [c.args[0] for c in run.call_args_list]
            self.assertFalse(any('--newmode' in c for c in commands))
            self.assertIn(['xrandr', '--delmode', 'VNC-0', 'octogee-900x700'], commands)
            self.assertIn(['xrandr', '--rmmode', 'octogee-900x700'], commands)

    def test_x11_command_failure_and_unapplied_modes_are_reported(self):
        for result in [
            SimpleNamespace(returncode=1, stdout=b'', stderr=b'bad mode'),
            SimpleNamespace(returncode=0, stdout=b'VNC-0 connected 1440x900+0+0', stderr=b''),
            SimpleNamespace(returncode=0, stdout=b'VNC-0 connected 800x600+0+01', stderr=b''),
        ]:
            with patch.object(control, 'COMPOSITOR', 'openbox'), patch.object(control, 'run', return_value=result):
                with self.assertRaises(RuntimeError):
                    control.resize(800, 600)

    def test_x11_windows_and_screenshots_use_the_visible_x11_session(self):
        with patch.object(control, 'COMPOSITOR', 'openbox'), patch.object(control, 'run') as run:
            run.return_value = SimpleNamespace(returncode=0, stdout=b'0x123 0 chromium.Chromium host Builder browser', stderr=b'')
            self.assertEqual(control.windows(), [{'address': '0x123', 'class': 'chromium.Chromium', 'title': 'Builder browser'}])
            run.assert_called_with(['wmctrl', '-lx'])
            run.return_value.stdout = b'png-image'
            self.assertEqual(control.screenshot_png(), b'png-image')
            run.assert_called_with(['import', '-window', 'root', 'png:-'], timeout=30)

    def test_http_request_validation_and_dispatch(self):
        for raw, expected in [(b'{"width":800,"height":600}', 200), (b'[]', 400), (b'bad', 400), (b'', 400)]:
            with self.subTest(raw=raw), patch.object(control, 'resize', return_value={'width': 800, 'height': 600}) as resize:
                handler = object.__new__(control.Handler)
                handler.path = '/resize'
                handler.headers = {'Content-Length': str(len(raw)), 'Content-Type': 'application/json'}
                handler.rfile = io.BytesIO(raw)
                with patch.object(handler, '_send') as send:
                    handler.do_POST()
                    self.assertEqual(send.call_args.args[0], expected)
                if expected == 200:
                    resize.assert_called_once_with(800, 600)
                else:
                    resize.assert_not_called()

    def test_rejects_invalid_dimensions_before_command(self):
        for width, height in [(True, 600), (0, 600), (800.5, 600), ('800', 600), (800, 99999)]:
            with self.subTest(width=width, height=height), patch.object(control, 'run') as run:
                with self.assertRaises(ValueError):
                    control.resize(width, height)
                run.assert_not_called()

    def test_resizes_only_configured_output_and_verifies(self):
        with patch.object(control, 'run') as run, patch.object(control, 'hyprctl_json', return_value=[{'name': control.OUTPUT, 'width': 800, 'height': 600}]):
            run.return_value.returncode = 0
            self.assertEqual(control.resize(800, 600), {'width': 800, 'height': 600})
            self.assertIn('800x600@30', run.call_args.args[0][-1])
            self.assertIn(control.OUTPUT, run.call_args.args[0][-1])

    def test_waits_for_compositor_to_apply_mode(self):
        with patch.object(control, 'run') as run, patch.object(control.time, 'sleep'), patch.object(control, 'hyprctl_json', side_effect=[
            [{'name': control.OUTPUT, 'width': 1440, 'height': 900}],
            [{'name': control.OUTPUT, 'width': 800, 'height': 600}],
        ]):
            run.return_value.returncode = 0
            self.assertEqual(control.resize(800, 600), {'width': 800, 'height': 600})

    def test_rejects_unapplied_mode(self):
        with patch.object(control, 'run') as run, patch.object(control, 'hyprctl_json', return_value=[{'name': control.OUTPUT, 'width': 1440, 'height': 900}]), patch.object(control.time, 'sleep'):
            run.return_value.returncode = 0
            with self.assertRaises(RuntimeError):
                control.resize(800, 600)

if __name__ == '__main__':
    unittest.main()
