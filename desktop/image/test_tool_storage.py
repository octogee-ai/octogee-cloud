from pathlib import Path
import runpy
import shutil
import os
import errno
import json
import contextlib
import io
import subprocess
import types
import sys
import time
from unittest.mock import patch
import tempfile
import unittest

SCRIPT = runpy.run_path(str(Path(__file__).parent / "rootfs/usr/local/bin/octo-desktop-tool-storage"))
PREPARE = SCRIPT["prepare_image"]

class ToolStorage(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name).resolve()
        self.home = self.root / "image-home"
        self.tools = self.root / "os-tools/mise"
        self.cache = self.root / "os-cache"
        self.home.mkdir(parents=True)
        if os.geteuid() == 0: os.chown(self.home, 1000, 1000)
        self.install = self.home / ".local/share/mise/installs/node/26/bin/node"
        self.install.parent.mkdir(parents=True)
        self.install.write_text("installed image binary")
        self.install.chmod(0o755)
        custom = self.home / ".local/share/mise/installs/node/99.0.0/bin/node"
        custom.parent.mkdir(parents=True)
        custom.write_text("user-pinned version")
        shims = self.home / ".local/share/mise/shims"
        shims.mkdir()
        (shims / "node").symlink_to("../installs/node/26/bin/node")
        downloads = self.home / ".cache/mise/downloads/node.tar.gz"
        downloads.parent.mkdir(parents=True)
        downloads.write_text("rebuildable download")
        npm = self.home / ".npm/_cacache/download"
        npm.parent.mkdir(parents=True)
        npm.write_text("rebuildable npm cache")
        for name in (".codex/auth.json", ".config/mise/config.toml", ".config/octogee-chromium/Default/Cookies", ".local/share/user-app/context.txt"):
            target = self.home / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("private user context")

    def invoke(self):
        PREPARE(self.home, self.tools, self.cache)

    def test_image_seed_contains_links_and_user_state_instead_of_tool_bytes(self):
        self.invoke()
        self.assertTrue((self.home / ".local/share/mise").is_symlink())
        self.assertTrue((self.home / ".cache/mise").is_symlink())
        self.assertTrue((self.home / ".npm").is_symlink())
        self.assertEqual((self.tools / "installs/node/26/bin/node").read_text(), "installed image binary")
        self.assertEqual((self.cache / "mise/downloads/node.tar.gz").read_text(), "rebuildable download")
        self.assertEqual((self.cache / "npm/_cacache/download").read_text(), "rebuildable npm cache")
        self.assertEqual(self.install.read_text(), "installed image binary")
        self.assertEqual(self.install.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.home / ".local/share/mise/shims/node").read_text(), "installed image binary")
        self.assertEqual((self.tools / "installs/node/99.0.0/bin/node").read_text(), "user-pinned version")
        seed = self.root / "durable-seed"
        shutil.copytree(self.home, seed, symlinks=True)
        self.assertTrue((seed / ".local/share/mise").is_symlink())
        for name in (".codex/auth.json", ".config/mise/config.toml", ".config/octogee-chromium/Default/Cookies", ".local/share/user-app/context.txt"):
            self.assertEqual((seed / name).read_text(), "private user context")

    def test_repeat_preparation_does_not_replace_tools_or_change_context(self):
        self.invoke()
        installed = self.tools / "installs/node/26/bin/node"
        before = installed.stat().st_ino
        self.invoke()
        self.assertEqual(installed.stat().st_ino, before)

    def test_foreign_symlink_is_rejected_without_following_or_deleting_it(self):
        source = self.home / ".local/share/mise"
        shutil.rmtree(source)
        foreign = self.root / "foreign"
        foreign.mkdir()
        (foreign / "auth.json").write_text("foreign private auth")
        source.symlink_to(foreign)
        with self.assertRaises(RuntimeError): self.invoke()
        self.assertEqual((foreign / "auth.json").read_text(), "foreign private auth")
        self.assertTrue(source.is_symlink())

    def test_retained_home_adopts_new_image_storage_without_losing_custom_versions(self):
        self.tools.mkdir(parents=True)
        (self.tools / "image-new-version").write_text("new image tool")
        (self.tools / "shims").mkdir()
        (self.tools / "shims/node").symlink_to("../installs/node/26/bin/node")
        self.invoke()
        self.assertTrue((self.home / ".local/share/mise").is_symlink())
        self.assertEqual(self.install.read_text(), "installed image binary")
        self.assertEqual((self.tools / "installs/node/99.0.0/bin/node").read_text(), "user-pinned version")
        self.assertEqual((self.tools / "image-new-version").read_text(), "new image tool")

    @unittest.skipUnless(Path("/dev/shm").is_dir(), "Linux separate mount required")
    def test_separate_filesystem_relocation_preserves_bytes_modes_and_shims(self):
        with tempfile.TemporaryDirectory(dir="/dev/shm") as directory:
            self.tools = Path(directory) / "mise"
            self.cache = Path(directory) / "cache"
            self.assertNotEqual(self.home.stat().st_dev, Path(directory).stat().st_dev)
            self.invoke()
            self.assertTrue((self.home / ".local/share/mise").is_symlink())
            self.assertEqual(self.install.read_text(), "installed image binary")
            self.assertEqual(self.install.stat().st_mode & 0o777, 0o755)
            self.assertEqual((self.home / ".local/share/mise/shims/node").read_text(), "installed image binary")

    def test_concurrent_source_change_blocks_handoff_and_preserves_both_writes(self):
        original_copy = shutil.copytree
        source = self.home / ".local/share/mise"
        def changed(*args, **kwargs):
            result = original_copy(*args, **kwargs)
            if Path(args[0]) == source:
                (source / "new-local-data").write_text("concurrent context")
            return result
        with patch("shutil.copytree", side_effect=changed), self.assertRaisesRegex(RuntimeError, "verification"):
            self.invoke()
        self.assertFalse(source.is_symlink())
        self.assertEqual(self.install.read_text(), "installed image binary")
        self.assertEqual((source / "new-local-data").read_text(), "concurrent context")

    def test_failed_cross_filesystem_copy_preserves_original_home_tools(self):
        with patch.object(Path, "rename", side_effect=OSError(errno.EXDEV, "different filesystems")), patch("shutil.copytree", side_effect=OSError("copy failed")):
            with self.assertRaisesRegex(RuntimeError, "copy"):
                self.invoke()
        self.assertFalse((self.home / ".local/share/mise").is_symlink())
        self.assertEqual(self.install.read_text(), "installed image binary")

    def test_failed_publication_restores_original_home_and_os_tools(self):
        self.tools.mkdir(parents=True)
        (self.tools / "image-only").write_text("image tool")
        rename = Path.rename
        def fail_stage(location, target):
            if location.name.startswith(".octogee-tool-stage-"):
                raise OSError("publication failed")
            return rename(location, target)
        with patch.object(Path, "rename", fail_stage), self.assertRaisesRegex(RuntimeError, "publication"):
            self.invoke()
        self.assertFalse((self.home / ".local/share/mise").is_symlink())
        self.assertEqual(self.install.read_text(), "installed image binary")
        self.assertEqual((self.tools / "image-only").read_text(), "image tool")

    def test_destination_links_cannot_redirect_copy_outside_owned_storage(self):
        foreign = self.root / "foreign"
        foreign.mkdir()
        self.tools.mkdir(parents=True)
        (self.tools / "installs").symlink_to(foreign)
        with self.assertRaises(RuntimeError): self.invoke()
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertEqual(self.install.read_text(), "installed image binary")

    def test_symlink_ancestor_is_rejected_without_entering_it(self):
        local = self.home / ".local"
        held = self.home / "held-local"
        local.rename(held)
        local.symlink_to(held)
        with self.assertRaises(RuntimeError): self.invoke()
        self.assertEqual((held / "share/mise/installs/node/26/bin/node").read_text(), "installed image binary")

class BootReconciliation(ToolStorage):
    def factory_metadata(self):
        installs = self.home / ".local/share/mise/installs"
        shutil.rmtree(installs)
        rows = {}
        for name, version in (("node", "26.8.2"), ("codex", "0.162.1")):
            location = installs / name / version
            location.mkdir(parents=True)
            (location / name).write_text("factory " + name)
            (location.parent / "latest").symlink_to(version)
            rows[name] = [{"version": version, "installed": True, "install_path": str(location)}]
        backend = 'short = "codex"\nfull = "aqua:openai/codex"\nexplicit_backend = false'
        (installs / "codex/.mise.backend.toml").write_text(backend)
        manifest = installs / ".mise-installs.toml"
        manifest.write_text("[codex]\n" + backend)
        def command(argv, **kwargs):
            if "ls" in argv: return types.SimpleNamespace(stdout=json.dumps(rows), returncode=0)
            return self.command(argv, **kwargs)
        return manifest, command

    def test_fresh_factory_mise_manifest_keeps_declared_tools_rebuildable(self):
        manifest, command = self.factory_metadata()
        content = manifest.read_bytes()
        self.invoke()
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=command, processes=lambda _uid: [])
        record = json.loads((self.home / ".config/octogee/mise-installs.json").read_text())
        self.assertTrue(record["rebuildable"])
        self.assertEqual(record["requests"], ["aqua:openai/codex@0.162.1", "node@26.8.2"])
        self.assertFalse((self.home / ".config/octogee/mise-retained").exists())
        self.assertEqual(manifest.read_bytes(), content)

    def test_manifest_must_cover_every_installed_backend_metadata_file(self):
        manifest, command = self.factory_metadata()
        metadata = manifest.parent / "node/.mise.backend.toml"
        metadata.write_text('short = "node"\nfull = "node"\nexplicit_backend = false')
        self.invoke()
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        self.assertEqual((self.home / ".config/octogee/mise-retained/installs/node/.mise.backend.toml").read_bytes(), metadata.read_bytes())

    def test_modified_backend_metadata_is_retained_despite_valid_root_manifest(self):
        manifest, command = self.factory_metadata()
        metadata = manifest.parent / "codex/.mise.backend.toml"
        metadata.write_text(metadata.read_text() + '\nprivate_context = "owned custom bytes"')
        self.invoke()
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        self.assertEqual((self.home / ".config/octogee/mise-retained/installs/codex/.mise.backend.toml").read_bytes(), metadata.read_bytes())

    def test_unknown_hidden_tool_context_is_retained_with_factory_manifest(self):
        manifest, command = self.factory_metadata()
        context = manifest.parent / "codex/.user-context"
        context.write_text("owned agent context")
        self.invoke()
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        self.assertEqual((self.home / ".config/octogee/mise-retained/installs/codex/.user-context").read_bytes(), context.read_bytes())

    def test_broken_unlisted_backend_link_is_retained(self):
        manifest, command = self.factory_metadata()
        metadata = manifest.parent / "node/.mise.backend.toml"
        metadata.symlink_to("missing-owned-backend")
        self.invoke()
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        self.assertEqual((self.home / ".config/octogee/mise-retained/installs/node/.mise.backend.toml").readlink(), metadata.readlink())

    def test_backend_context_without_a_root_manifest_is_retained(self):
        manifest, command = self.factory_metadata()
        metadata = manifest.parent / "codex/.mise.backend.toml"
        metadata.write_text(metadata.read_text() + '\nprivate_context = "owned agent context"')
        manifest.unlink()
        self.invoke()
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        self.assertEqual((self.home / ".config/octogee/mise-retained/installs/codex/.mise.backend.toml").read_bytes(), metadata.read_bytes())

    def test_unknown_regular_installs_file_is_still_retained(self):
        manifest, command = self.factory_metadata()
        unknown = manifest.with_name(".user-tools.toml")
        unknown.write_text("owned custom bytes")
        self.invoke()
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        self.assertEqual(unknown.read_text(), "owned custom bytes")
        self.assertEqual((self.home / ".config/octogee/mise-retained/installs/.user-tools.toml").read_text(), "owned custom bytes")

    def test_manifest_symlink_does_not_make_foreign_metadata_rebuildable(self):
        manifest, command = self.factory_metadata()
        foreign = self.root / "foreign-manifest"
        manifest.rename(foreign)
        original = foreign.read_bytes()
        manifest.symlink_to(foreign)
        self.invoke()
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        self.assertEqual(foreign.read_bytes(), original)
        self.assertTrue((self.home / ".config/octogee/mise-retained/installs/.mise-installs.toml").is_symlink())

    def test_manifest_directory_is_not_metadata(self):
        manifest, command = self.factory_metadata()
        manifest.unlink()
        manifest.mkdir()
        self.invoke()
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        self.assertTrue((self.home / ".config/octogee/mise-retained/installs/.mise-installs.toml").is_dir())

    def test_manifest_requires_known_schema_and_matching_declared_backend(self):
        manifest, command = self.factory_metadata()
        self.invoke()
        valid = manifest.read_text()
        malformed = [
            "", "# private bytes", "[codex", 'codex = "private bytes"',
            valid.replace('short = "codex"', 'short = "foreign"'),
            valid.replace('full = "aqua:openai/codex"', 'full = "aqua:foreign/codex"'),
            valid.replace('explicit_backend = false', 'explicit_backend = "false"'),
            valid.replace('[codex]', '[foreign]'),
            valid + '\nprivate_context = "owned bytes"',
            valid + '\nopts = { local_path = "/owned/tool" }',
        ]
        for content in malformed:
            with self.subTest(content=content):
                manifest.write_text(content)
                self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
                self.assertEqual(manifest.read_text(), content)
                self.assertEqual((self.home / ".config/octogee/mise-retained/installs/.mise-installs.toml").read_text(), content)

    def command(self, argv, **kwargs):
        self.calls.append(argv)
        if "show" in argv:
            return types.SimpleNamespace(stdout="inactive\ninactive\ninactive\n", returncode=0)
        if "ls" in argv:
            rows = [{"version": version.name, "installed": True, "install_path": str(version)} for version in (self.home / ".local/share/mise/installs/node").glob("*") if version.is_dir()]
            return types.SimpleNamespace(stdout=json.dumps({"node": rows}), returncode=0)
        if "install" in argv:
            for request in argv:
                if request.startswith("node@"):
                    file = self.tools / "installs/node" / request.split("@", 1)[1] / "bin/node"
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_text("rebuilt exact version")
        return types.SimpleNamespace(stdout="", returncode=0)

    def setUp(self):
        super().setUp()
        self.calls = []

    def test_retained_home_boot_reconciles_before_declared_writers(self):
        reconcile = SCRIPT.get("reconcile_boot", lambda *_args, **_kwargs: None)
        reconcile(self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        self.assertTrue((self.home / ".local/share/mise").is_symlink())
        self.assertTrue((self.home / ".config/octogee/mise-installs.json").is_file())
        unit = (Path(__file__).parent / "rootfs/etc/systemd/system/octo-home-disk.service").read_text()
        self.assertIn("ExecStartPost=/usr/local/bin/octo-desktop-tool-storage --reconcile", unit)
        migration = (Path(__file__).parent / "rootfs/etc/systemd/system/octo-home-migrate.service").read_text()
        self.assertIn("After=octo-home-disk.service user@1000.service", migration)
        for file in ("sshd.service.d/10-octogee-home-authorization.conf", "user@1000.service.d/10-octogee-home.conf", "octo-desktop.service"):
            value = (Path(__file__).parent / "rootfs/etc/systemd/system" / file).read_text()
            self.assertIn("octo-home-migrate.service" if file == "octo-desktop.service" else "octo-home-disk.service", value)

    def test_active_ssh_or_owner_process_blocks_boot_copy_without_mutation(self):
        reconcile = SCRIPT.get("reconcile_boot", lambda *_args, **_kwargs: None)
        active = lambda argv, **kwargs: types.SimpleNamespace(stdout="inactive\ninactive\nactive\n", returncode=0)
        for run, processes in ((active, lambda _uid: []), (self.command, lambda _uid: [99])):
            with self.subTest(), self.assertRaisesRegex(RuntimeError, "writers"):
                reconcile(self.home, self.tools, self.cache, run=run, processes=processes)
        self.assertFalse((self.home / ".local/share/mise").is_symlink())
        self.assertEqual(self.install.read_text(), "installed image binary")

    def test_os_rebuild_restores_recorded_custom_version_before_admission(self):
        reconcile = SCRIPT.get("reconcile_boot", lambda *_args, **_kwargs: None)
        reconcile(self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        shutil.rmtree(self.tools, ignore_errors=True)
        self.tools.mkdir(parents=True)
        reconcile(self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        self.assertEqual(self.install.read_text(), "rebuilt exact version")
        self.assertTrue(any("install" in argv and "node@26" in argv for argv in self.calls))

    def test_optional_cache_is_not_read_by_tool_inventory(self):
        def command(argv, **kwargs):
            self.assertNotEqual(kwargs.get("env", {}).get("MISE_CACHE_DIR"), str(self.home / ".cache/mise"))
            return self.command(argv, **kwargs)
        self.assertTrue(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])

    def test_local_install_remains_in_home_and_is_reported_for_operator_cleanup(self):
        def command(argv, **kwargs):
            result = self.command(argv, **kwargs)
            if "ls" in argv:
                value = json.loads(result.stdout)
                value["node"][0]["symlinked_to"] = str(self.home / "local-custom-tool")
                result.stdout = json.dumps(value)
            return result
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=command, processes=lambda _uid: [])
        self.assertFalse((self.home / ".local/share/mise").is_symlink())
        self.assertEqual(self.install.read_text(), "installed image binary")
        self.assertFalse(json.loads((self.home / ".config/octogee/mise-installs.json").read_text())["rebuildable"])

    def test_projected_local_install_is_retained_durably_before_checkpoint(self):
        self.invoke()
        def command(argv, **kwargs):
            result = self.command(argv, **kwargs)
            if "ls" in argv:
                value = json.loads(result.stdout)
                value["node"][0]["symlinked_to"] = str(self.home / "local-custom-tool")
                result.stdout = json.dumps(value)
            return result
        self.assertFalse(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])
        retained = self.home / ".config/octogee/mise-retained/installs/node/26/bin/node"
        self.assertEqual(retained.read_text(), "installed image binary")
        shutil.rmtree(self.tools)
        self.tools.mkdir()
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        self.assertEqual(self.install.read_text(), "installed image binary")
        self.assertEqual(retained.read_text(), "installed image binary")

    def test_failed_rebuild_does_not_erase_custom_version_declarations(self):
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        shutil.rmtree(self.tools)
        self.tools.mkdir()
        def fail(argv, **kwargs):
            if "install" in argv: raise subprocess.CalledProcessError(1, argv)
            return self.command(argv, **kwargs)
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=fail, processes=lambda _uid: [])
        self.assertIn('mise tool rebuild pending (CalledProcessError)', errors.getvalue())
        SCRIPT["record_tools"](self.home, self.tools, self.command)
        ledger = self.home / ".config/octogee/mise-installs.json"
        self.assertIn("node@99.0.0", json.loads(ledger.read_text()).get("pendingRequests", []))
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        self.assertEqual((self.tools / "installs/node/99.0.0/bin/node").read_text(), "rebuilt exact version")
        self.assertNotIn("pendingRequests", json.loads(ledger.read_text()))

    def test_failed_config_rebuild_keeps_declared_config_and_allows_boot_retry(self):
        config = self.home / ".config/mise/config.toml"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text('[tools]\nnode = "99.0.0"\n')
        original = self.install.read_text()
        def fail(argv, **kwargs):
            if "install" in argv: raise subprocess.CalledProcessError(1, argv)
            return self.command(argv, **kwargs)
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=fail, processes=lambda _uid: [])
        self.assertIn("mise tool rebuild pending (CalledProcessError)", errors.getvalue())
        self.assertEqual(config.read_text(), '[tools]\nnode = "99.0.0"\n')
        self.assertEqual(self.install.read_text(), original)
        self.calls.clear()
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        self.assertTrue(any(argv[-1] == "install" for argv in self.calls))
        self.assertEqual(config.read_text(), '[tools]\nnode = "99.0.0"\n')

    def test_hanging_rebuild_has_a_bounded_timeout_and_retains_pending_requests(self):
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        shutil.rmtree(self.tools)
        self.tools.mkdir()
        def hang(argv, **kwargs):
            if "install" in argv:
                self.assertGreater(kwargs.get("timeout", 0), 0)
                self.assertLessEqual(kwargs["timeout"], 180)
                raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
            return self.command(argv, **kwargs)
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=hang, processes=lambda _uid: [])
        self.assertIn("mise tool rebuild pending (TimeoutExpired)", errors.getvalue())
        ledger = self.home / ".config/octogee/mise-installs.json"
        self.assertIn("node@99.0.0", json.loads(ledger.read_text())["pendingRequests"])
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        self.assertEqual((self.tools / "installs/node/99.0.0/bin/node").read_text(), "rebuilt exact version")
        self.assertNotIn("pendingRequests", json.loads(ledger.read_text()))

    def test_missing_and_configured_installations_share_one_total_deadline(self):
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        shutil.rmtree(self.tools)
        self.tools.mkdir()
        timeouts = []
        def command(argv, **kwargs):
            if "install" in argv: timeouts.append(kwargs.get("timeout"))
            return self.command(argv, **kwargs)
        ticks = iter([10, 10, 70])
        with patch.dict(SCRIPT["reconcile_boot"].__globals__, {"time": types.SimpleNamespace(monotonic=lambda: next(ticks))}):
            SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=command, processes=lambda _uid: [])
        self.assertEqual(timeouts, [180, 120])

    def test_inventory_reads_are_bounded_independently_of_installation(self):
        def command(argv, **kwargs):
            if "ls" in argv: self.assertEqual(kwargs.get("timeout"), 30)
            return self.command(argv, **kwargs)
        self.assertTrue(SCRIPT["record_tools"](self.home, self.tools, command)["rebuildable"])

    @unittest.skipUnless(sys.platform == "linux", "native process custody uses Linux /proc")
    def test_timeout_reaps_mise_and_terminates_its_term_ignoring_installer(self):
        marker = self.root / "installer-writes"
        program = "import os,signal,time; child=os.fork(); " + "\nif child == 0:\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n while True:\n  with open(" + repr(str(marker)) + ", 'a') as file: file.write('write\\n')\n  time.sleep(.01)\nelse:\n time.sleep(60)\n"
        with self.assertRaises(subprocess.TimeoutExpired):
            SCRIPT["run_mise_command"]([sys.executable, "-c", program], env=os.environ.copy(), cwd=self.root, timeout=.2)
        self.assertTrue(marker.exists())
        content = marker.read_bytes()
        time.sleep(.15)
        self.assertEqual(marker.read_bytes(), content, "orphan installer continued writing after deadline custody ended")

    def test_owner_fence_ignores_exited_zombies_but_keeps_live_writers(self):
        class Process:
            def __init__(self, pid, state, uid): self.name, self.state, self.uid = str(pid), state, uid
            def stat(self): return types.SimpleNamespace(st_uid=self.uid)
            def __truediv__(self, _name): return types.SimpleNamespace(read_text=lambda: self.name + " (writer) " + self.state + " 1 123 123 0")
        entries = [Process(10, "Z", 1000), Process(11, "X", 1000), Process(12, "S", 1000), Process(13, "R", 0)]
        with patch.dict(SCRIPT["owner_processes"].__globals__, {"Path": lambda _path: types.SimpleNamespace(iterdir=lambda: entries)}):
            self.assertEqual(SCRIPT["owner_processes"](1000), [12])

    def test_process_scans_skip_processes_that_exit_while_listed(self):
        class Process:
            def __init__(self, pid, failure=None): self.name, self.failure = str(pid), failure
            def stat(self): return types.SimpleNamespace(st_uid=1000)
            def __truediv__(self, _name):
                def read_text():
                    if self.failure: raise self.failure
                    return self.name + " (writer) S 1 77 77 0"
                return types.SimpleNamespace(read_text=read_text)
        entries = [Process(20, ProcessLookupError(3, "No such process")), Process(21, FileNotFoundError(2, "gone")), Process(22)]
        with patch.dict(SCRIPT["owner_processes"].__globals__, {"Path": lambda _path: types.SimpleNamespace(iterdir=lambda: entries)}):
            self.assertEqual(SCRIPT["owner_processes"](1000), [22])
            self.assertEqual(SCRIPT["process_group_writers"](77), [22])

    def test_remaining_owner_process_after_install_is_a_strict_boot_failure(self):
        observed = iter([[], [], [99]])
        with self.assertRaisesRegex(RuntimeError, "writers"):
            SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: next(observed))

    def test_unavailable_tool_executable_remains_a_strict_boot_failure(self):
        def missing(argv, **kwargs):
            if "install" in argv: raise FileNotFoundError("missing /usr/bin/mise")
            return self.command(argv, **kwargs)
        with self.assertRaisesRegex(FileNotFoundError, "missing /usr/bin/mise"):
            SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=missing, processes=lambda _uid: [])

    def test_tool_copy_failure_remains_a_strict_boot_failure(self):
        with patch.dict(SCRIPT["reconcile_boot"].__globals__, {"project_tree": lambda *_args: (_ for _ in ()).throw(RuntimeError("unsafe copy"))}):
            with self.assertRaisesRegex(RuntimeError, "unsafe copy"):
                SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])

    def test_inventory_after_success_does_not_rebuild_intentionally_removed_versions(self):
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        shutil.rmtree(self.tools / "installs/node/99.0.0")
        SCRIPT["record_tools"](self.home, self.tools, self.command)
        self.calls.clear()
        SCRIPT["reconcile_boot"](self.home, self.tools, self.cache, run=self.command, processes=lambda _uid: [])
        self.assertFalse((self.tools / "installs/node/99.0.0").exists())
        self.assertFalse(any("node@99.0.0" in argv for argv in self.calls))

if __name__ == "__main__": unittest.main()
