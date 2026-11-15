#!/usr/bin/env python3
import json
import os
import sys

MIB = 1024 * 1024
BOOT_START_MIB = 1
BOOT_SIZE_MIB = 2048


def render(template_path: str, disk_gb: int) -> str:
    total_mib = disk_gb * 1024
    main_start_mib = BOOT_START_MIB + BOOT_SIZE_MIB
    main_size_mib = total_mib - main_start_mib - 1
    if main_size_mib <= 0:
        raise SystemExit(f"disk of {disk_gb} GB is too small for the layout")
    text = open(template_path).read()
    for key, value in {
        "__BOOT_START_B__": BOOT_START_MIB * MIB,
        "__BOOT_SIZE_B__": BOOT_SIZE_MIB * MIB,
        "__MAIN_START_B__": main_start_mib * MIB,
        "__MAIN_SIZE_B__": main_size_mib * MIB,
    }.items():
        text = text.replace(f'"{key}"', str(value))
    json.loads(text)
    return text


if __name__ == "__main__":
    sys.stdout.write(render(sys.argv[1], int(os.environ.get("DISK_GB", "40"))))
