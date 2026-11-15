#!/usr/bin/env python3
import ctypes
import json
import struct
import time
from urllib.request import Request, urlopen


def xwayland_size():
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    for name in ('XDefaultScreen', 'XCloseDisplay'):
        getattr(x11, name).argtypes = [ctypes.c_void_p]
    for name in ('XDisplayWidth', 'XDisplayHeight'):
        getattr(x11, name).argtypes = [ctypes.c_void_p, ctypes.c_int]
    display = x11.XOpenDisplay(b':0')
    if not display:
        raise RuntimeError('XWayland display :0 unavailable')
    try:
        screen = x11.XDefaultScreen(display)
        return x11.XDisplayWidth(display, screen), x11.XDisplayHeight(display, screen)
    finally:
        x11.XCloseDisplay(display)


def screenshot_size():
    with urlopen('http://127.0.0.1:7777/screenshot', timeout=30) as response:
        header = response.read(24)
    if header[:8] != b'\x89PNG\r\n\x1a\n':
        raise RuntimeError('desktop screenshot is not PNG')
    return struct.unpack('>II', header[16:24])


def resize(width, height):
    dimensions = {'width': width, 'height': height}
    request = Request('http://127.0.0.1:7777/resize', data=json.dumps(dimensions).encode(), headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=20) as response:
        actual = json.load(response)
    if actual != dimensions:
        raise RuntimeError(f'resize response mismatch: {actual}')
    for _ in range(20):
        if screenshot_size() == (width, height) and xwayland_size() == (width, height):
            print(f'display resize verified: {width}x{height}', flush=True)
            return
        time.sleep(0.1)
    raise RuntimeError(f'screenshot or XWayland geometry did not follow {width}x{height}')


def main():
    try:
        resize(800, 600)
        resize(1024, 768)
    finally:
        resize(1440, 900)


if __name__ == '__main__':
    main()
