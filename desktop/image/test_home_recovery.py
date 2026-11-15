import json
from pathlib import Path
import runpy
import tempfile
import unittest

SCRIPT = runpy.run_path(str(Path(__file__).parent / "rootfs/usr/local/bin/octo-home-recovery"))
ACCEPT = SCRIPT["accept"]
MACHINE = "a" * 32
HEALTH = {key: True for key in ("ready", "openclawUp", "brokerProfilesSettled", "dashboardBridgeReady", "handoffReleased")}
HEALTH.update(runtimeStatus="ready", prelaunchState="serving")


class Recovery(unittest.TestCase):
    def fixture(self, health=None, foreign=False):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        (root / "image").write_text("image-new")
        (root / "machine").write_text(MACHINE)
        recovery = root / ".home-checkpoint/pre-migration"
        current = self.point(recovery, f"image-new-{MACHINE}")
        old = self.point(recovery, "image-old-" + "b" * 32)
        calls = []
        def run(argv):
            calls.append(argv)
            if argv[0] == "btrfs":
                if "delete" in argv:
                    import shutil
                    shutil.rmtree(argv[-1])
                return "ro=true" if "property" in argv else ""
            if argv[0] == "curl":
                return "b-x" if "metadata" in argv[-1] or "169.254" in argv[-1] else json.dumps(HEALTH if health is None else health)
            return json.dumps([{ "State": {"Running": True, "Paused": False}, "Config": {"Labels": {"ai.octogee.gateway-id": "other" if foreign else "b-x", "ai.octogee.bundle-version": "v1"}} }])
        invoke = lambda: ACCEPT(root, root / "image", root / "machine", run)
        return root, recovery, current, old, calls, invoke

    def point(self, recovery, name):
        point = recovery / name
        (point / ".home-checkpoint").mkdir(parents=True)
        (point / ".home-checkpoint/recovery-point").write_text(name)
        (point / "user-state").write_text("retained")
        return point

    def test_native_success_retires_only_verified_older_point_and_keeps_current(self):
        root, recovery, current, old, calls, invoke = self.fixture()
        result = invoke()
        self.assertTrue(result["ready"])
        self.assertEqual(result["retainedPoints"], 1)
        self.assertEqual((current / "user-state").read_text(), "retained")
        self.assertFalse(old.exists())
        self.assertIn(["btrfs", "subvolume", "sync", str(root)], calls)
        self.assertEqual(invoke()["retainedPoints"], 1)

    def test_repeated_accepted_updates_remain_bounded_without_manual_cleanup(self):
        root, recovery, current, old, calls, invoke = self.fixture()
        self.assertEqual(invoke()["retainedPoints"], 1)
        for index in range(3):
            machine = str(index + 1) * 32
            (root / "machine").write_text(machine)
            current = self.point(recovery, "image-new-" + machine)
            self.assertEqual(invoke()["retainedPoints"], 1)
            self.assertTrue(current.exists())

    def test_native_failure_after_omarchy_success_keeps_both_points_until_real_readiness(self):
        health = {**HEALTH, "ready": False, "openclawUp": False}
        root, recovery, current, old, calls, invoke = self.fixture(health)
        for reboot in range(2):
            self.assertFalse(invoke()["ready"])
            self.assertTrue(old.exists())
            self.assertTrue(current.exists())
        self.assertFalse(any("delete" in argv for argv in calls))
        health.update(HEALTH)
        self.assertTrue(invoke()["ready"])
        self.assertEqual(len(list(recovery.iterdir())), 1)

    def test_prelaunch_hold_and_wrong_binding_never_retire_points(self):
        for health, foreign in [({**HEALTH, "handoffReleased": False}, False), ({**HEALTH, "prelaunchState": "held"}, False), (HEALTH, True)]:
            root, recovery, current, old, calls, invoke = self.fixture(health, foreign)
            self.assertFalse(invoke()["ready"])
            self.assertTrue(old.exists())

    def test_unverified_older_point_is_retained_and_reported_as_full(self):
        root, recovery, current, old, calls, invoke = self.fixture()
        (old / ".home-checkpoint/recovery-point").write_text("different")
        result = invoke()
        self.assertTrue(result["ready"])
        self.assertEqual(result["retainedPoints"], 2)
        self.assertTrue(old.exists())


if __name__ == "__main__":
    unittest.main()
