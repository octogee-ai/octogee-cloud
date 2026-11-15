import importlib.util
import json
import os
import pathlib
import sys
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('launcher', pathlib.Path(__file__).parents[1] / 'libexec/source-transfer-launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
namespace_thread_count = launcher.namespace_thread_count


class LauncherTest(unittest.TestCase):
    def setUp(self):
        if os.environ.get('OCTOGEE_ISOLATED_PID_TEST') != '1':
            counter = patch.object(launcher, 'namespace_thread_count', return_value=1)
            counter.start()
            self.addCleanup(counter.stop)

    def test_namespace_counter_counts_only_numeric_process_task_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = pathlib.Path(directory)
            for process, tasks in [('10', ['10', '11']), ('20', ['20']), ('self', ['10'])]:
                for task in tasks:
                    (proc / process / 'task' / task).mkdir(parents=True)
            (proc / '30').mkdir()
            with patch.object(launcher.pathlib, 'Path', return_value=proc):
                self.assertEqual(namespace_thread_count(), 3)

    def test_missing_unbounded_and_insufficient_resources_reject(self):
        now = 100000
        for maximum, current in [('max', 0), (10, 11), (8 * 1024**3, 5 * 1024**3)]:
            with self.assertRaises(ValueError):
                launcher.resource_admission({'observedAt': now, 'sourceMemoryMax': maximum, 'sourceMemoryCurrent': current}, 10 * 1024**3, 10 * 1024**3, now)
        admission = {'observedAt': now, 'sourceMemoryMax': 8 * 1024**3, 'sourceMemoryCurrent': 4 * 1024**3}
        launcher.resource_admission(admission, 10 * 1024**3, 10 * 1024**3, now)
        with self.assertRaises(ValueError):
            launcher.resource_admission(admission, 10 * 1024**3, 10 * 1024**3, now + 30001)

    @unittest.skipUnless(sys.platform == "linux", "Linux child limits tested in immutable image")
    def test_native_limits_are_enforced_before_exec(self):
        with tempfile.TemporaryDirectory() as scratch:
            output = pathlib.Path(scratch, 'out')
            script = "import json,resource;print(json.dumps([resource.getrlimit(resource.RLIMIT_AS),resource.getrlimit(resource.RLIMIT_STACK)]))"
            launcher.run_child([sys.executable, '-c', script], dict(os.environ), scratch, output, time.monotonic() + 5)
            self.assertEqual(json.loads(output.read_text()), [[1536 * launcher.MIB] * 2, [2 * launcher.MIB] * 2])

    def test_source_requires_readonly_mount_without_writable_child(self):
        mount = '1 0 0:1 / /home/node ro,relatime - tmpfs tmpfs rw\n'
        launcher.readonly_source(mount)
        with self.assertRaises(ValueError):
            launcher.readonly_source(mount.replace('ro,relatime', 'rw,relatime'))
        with self.assertRaises(ValueError):
            launcher.readonly_source(mount + '2 1 0:2 / /home/node/.openclaw rw - tmpfs tmpfs rw\n')

    @unittest.skipUnless(sys.platform == "linux", "Linux RLIMIT execution tested in immutable image")
    def test_failed_child_cannot_produce_success(self):
        with tempfile.TemporaryDirectory() as scratch:
            with self.assertRaises(ValueError):
                launcher.run_child([sys.executable, '-c', 'raise SystemExit(2)'], dict(os.environ), scratch, pathlib.Path(scratch, 'out'), time.monotonic() + 5)

    @unittest.skipUnless(sys.platform == "linux", "Linux RLIMIT execution tested in immutable image")
    def test_deadline_kills_child(self):
        with tempfile.TemporaryDirectory() as scratch:
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                launcher.run_child([sys.executable, '-c', 'import time;time.sleep(20)'], dict(os.environ), scratch, pathlib.Path(scratch, 'out'), time.monotonic() + .2)
            self.assertLess(time.monotonic() - started, 3)

    @unittest.skipUnless(sys.platform == "linux", "Linux execution tested in immutable image")
    def test_output_limit_stops_writer(self):
        with tempfile.TemporaryDirectory() as scratch:
            with self.assertRaises(ValueError):
                launcher.run_child([sys.executable, '-c', 'import sys;sys.stdout.write("x"*3000000)'], dict(os.environ), scratch, pathlib.Path(scratch, 'out'), time.monotonic() + 5)
            self.assertLessEqual(pathlib.Path(scratch, 'out').stat().st_size, 2 * launcher.MIB)

    @unittest.skipUnless(sys.platform == "linux", "Linux execution tested in immutable image")
    def test_deadline_stops_descendant(self):
        with tempfile.TemporaryDirectory() as scratch:
            pidfile = pathlib.Path(scratch, 'pid')
            script = "import subprocess,sys,time,pathlib;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)']);pathlib.Path(sys.argv[1]).write_text(str(p.pid));time.sleep(20)"
            with self.assertRaises(TimeoutError):
                launcher.run_child([sys.executable, '-c', script, str(pidfile)], dict(os.environ), scratch, pathlib.Path(scratch, 'out'), time.monotonic() + .5)
            pid = int(pidfile.read_text())
            status = pathlib.Path(f'/proc/{pid}/stat')
            for _ in range(20):
                try:
                    stopped = status.read_text().split()[2] == 'Z'
                except (FileNotFoundError, ProcessLookupError):
                    return
                if stopped:
                    return
                time.sleep(.05)
            self.fail('descendant remained running')

    @unittest.skipUnless(sys.platform == "linux", "Linux signal execution tested in immutable image")
    def test_sigterm_reaps_child_group(self):
        with tempfile.TemporaryDirectory() as scratch:
            pidfile = pathlib.Path(scratch, 'pid')
            module = str(pathlib.Path(__file__).parents[1] / 'libexec/source-transfer-launcher.py')
            child_script = "import os,pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(20)"
            driver = f"import importlib.util,os,pathlib,sys,time;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('l',{module!r});l=importlib.util.module_from_spec(s);s.loader.exec_module(l);l.install_signal_handlers();l.namespace_thread_count=l.namespace_thread_count if os.environ.get('OCTOGEE_ISOLATED_PID_TEST')=='1' else lambda:1;l.run_child([sys.executable,'-c',{child_script!r},{str(pidfile)!r}],dict(os.environ),{scratch!r},pathlib.Path({scratch!r},'out'),time.monotonic()+20)"
            process = subprocess.Popen([sys.executable, '-c', driver], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    if pidfile.exists():
                        break
                    time.sleep(.02)
                self.assertTrue(pidfile.exists())
                process.send_signal(signal.SIGTERM)
                self.assertNotEqual(process.wait(timeout=3), 0)
                self.assertFalse(pathlib.Path('/proc', pidfile.read_text(), 'stat').exists())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    @unittest.skipUnless(sys.platform == "linux", "Linux address-space enforcement tested in immutable image")
    def test_transfer_address_space_limit_rejects_oversized_mapping(self):
        with tempfile.TemporaryDirectory() as scratch:
            script = "import json,mmap,resource\nrejected=False\ntry:\n mmap.mmap(-1,600*1024*1024)\nexcept OSError:\n rejected=True\nprint(json.dumps({'limit':resource.getrlimit(resource.RLIMIT_AS),'rejected':rejected}))"
            output = pathlib.Path(scratch, 'out')
            launcher.run_child([sys.executable, '-c', script], dict(os.environ), scratch, output, time.monotonic() + 5, 512 * launcher.MIB)
            result = json.loads(output.read_text())
            self.assertEqual(result['limit'], [512 * launcher.MIB, 512 * launcher.MIB])
            self.assertTrue(result['rejected'])

    @unittest.skipUnless(sys.platform == "linux", "Linux process namespace monitoring tested in immutable image")
    def test_excess_namespace_threads_terminate_child(self):
        with tempfile.TemporaryDirectory() as scratch:
            script = "import pathlib,os,threading,time;pathlib.Path('pid').write_text(str(os.getpid()));threading.stack_size(max(65536,os.sysconf('SC_THREAD_STACK_MIN')));threads=[threading.Thread(target=lambda:time.sleep(20),daemon=True) for _ in range(70)];[t.start() for t in threads];time.sleep(20)"
            env = {**os.environ, 'MALLOC_ARENA_MAX': '1'}
            def child_thread_count():
                pidfile = pathlib.Path(scratch, 'pid')
                if not pidfile.exists():
                    return 1
                return sum(1 for _ in pathlib.Path('/proc', pidfile.read_text(), 'task').iterdir())
            counter = namespace_thread_count if os.environ.get('OCTOGEE_ISOLATED_PID_TEST') == '1' else child_thread_count
            with patch.object(launcher, 'namespace_thread_count', side_effect=counter), self.assertRaisesRegex(ValueError, 'namespace thread budget exceeded'):
                launcher.run_child([sys.executable, '-c', script], env, scratch, pathlib.Path(scratch, 'out'), time.monotonic() + 5)
            self.assertFalse(pathlib.Path('/proc', pathlib.Path(scratch, 'pid').read_text(), 'stat').exists())


if __name__ == '__main__':
    unittest.main()
