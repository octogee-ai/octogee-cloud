import io
import json
import runpy
import struct
import unittest
from pathlib import Path
from unittest.mock import patch

scope = runpy.run_path(str(Path(__file__).parents[1] / 'acceptance/display-resize.py'))
resize = scope['resize']
main = scope['main']


class DisplayResizeTests(unittest.TestCase):
    def test_checks_response_screenshot_and_xwayland(self):
        with patch.dict(resize.__globals__, {
            'urlopen': lambda *args, **kwargs: io.BytesIO(json.dumps({'width': 800, 'height': 600}).encode()),
            'screenshot_size': lambda: (800, 600), 'xwayland_size': lambda: (800, 600),
        }):
            resize(800, 600)

    def test_rejects_unapplied_geometry(self):
        for screenshot, xwayland in [((1440, 900), (800, 600)), ((800, 600), (1440, 900))]:
            with self.subTest(screenshot=screenshot, xwayland=xwayland), patch.dict(resize.__globals__, {
                'urlopen': lambda *args, **kwargs: io.BytesIO(json.dumps({'width': 800, 'height': 600}).encode()),
                'screenshot_size': lambda: screenshot, 'xwayland_size': lambda: xwayland,
            }), patch('time.sleep'):
                with self.assertRaises(RuntimeError):
                    resize(800, 600)

    def test_restores_fixed_size_after_failure(self):
        calls = []
        def fail_resize(width, height):
            calls.append((width, height))
            if width == 800:
                raise RuntimeError('resize unavailable')
        with patch.dict(main.__globals__, {'resize': fail_resize}):
            with self.assertRaises(RuntimeError):
                main()
        self.assertEqual(calls, [(800, 600), (1440, 900)])

    def test_reads_png_dimensions(self):
        read_size = scope['screenshot_size']
        png = b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('>II', 1024, 768)
        with patch.dict(read_size.__globals__, {'urlopen': lambda *args, **kwargs: io.BytesIO(png)}):
            self.assertEqual(read_size(), (1024, 768))


if __name__ == '__main__':
    unittest.main()
