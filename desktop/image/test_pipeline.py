import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest


class FailureEvidenceTests(unittest.TestCase):
    def run_failure(self, started=True, running=True, upload_fails=False):
        functions = Path(__file__).with_name('pipeline.sh').read_text().split('mkdir -p "$WORK"', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'serial.log').write_text('installer failed')
            with socket.socket(socket.AF_UNIX) as monitor:
                monitor.bind(str(root / 'monitor.sock'))
                result = subprocess.run(['bash', '-c', functions + r'''
WORK="$EVIDENCE_WORK"
MONITOR="$WORK/monitor.sock"
guest_started="$TEST_STARTED"
qemu_running() { [[ "$TEST_RUNNING" == 1 ]]; }
socat() { read -r command path; [[ "$command" == screendump ]]; printf 'screen' > "$path"; }
gcloud() {
  printf '%s\n' "$*" >> "$WORK/uploads"
  [[ "$TEST_UPLOAD_FAILS" == 0 ]]
}
die 'installation timed out'
'''], env={**os.environ, 'OMARCHY_VERSION': 'fixture', 'OMARCHY_ISO_SHA256': 'fixture',
                       'IMAGE_NAME': 'candidate', 'IMAGE_BUCKET': 'gs://fixture', 'DISK_GB': '40',
                       'IMAGE_DEVICE': '/dev/disk/by-id/google-octogee-image',
                       'EVIDENCE_WORK': directory, 'TEST_STARTED': str(int(started)),
                       'TEST_RUNNING': str(int(running)), 'TEST_UPLOAD_FAILS': str(int(upload_fails))},
                    capture_output=True, text=True, timeout=10)
            uploads = (root / 'uploads').read_text() if (root / 'uploads').exists() else ''
            return result, uploads

    def test_install_timeout_captures_screen_and_serial_before_exiting(self):
        result, uploads = self.run_failure()
        self.assertEqual(result.returncode, 1)
        self.assertIn('ERROR: installation timed out', result.stdout)
        self.assertIn('gs://fixture/images/candidate.failed.screen.ppm', uploads)
        self.assertIn('gs://fixture/images/candidate.failed.serial.log', uploads)

    def test_failure_before_guest_start_does_not_upload_evidence(self):
        result, uploads = self.run_failure(started=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(uploads, '')

    def test_exited_guest_still_uploads_serial(self):
        result, uploads = self.run_failure(running=False)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('screen.ppm', uploads)
        self.assertIn('candidate.failed.serial.log', uploads)

    def test_upload_failure_is_logged_and_does_not_skip_other_evidence(self):
        result, uploads = self.run_failure(upload_fails=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.count('could not upload failure evidence'), 2)
        self.assertIn('candidate.failed.serial.log', uploads)


class ImageDiskTests(unittest.TestCase):
    def prepare(self, device_bytes, block_device=True):
        functions = Path(__file__).with_name('pipeline.sh').read_text().split('mkdir -p "$WORK"', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['bash', '-c', functions + r'''
guest_started=0
sudo() {
  printf '%s\n' "$*" >> "$EVIDENCE_WORK/sudo"
  case "$1" in blockdev) echo "$TEST_DEVICE_BYTES" ;; esac
}
readlink() { echo /dev/sdb; }
is_block_device() { [[ "$TEST_BLOCK" == 1 ]]; }
prepare_image_disk
echo "DISK=$DISK"
'''], env={**os.environ, 'OMARCHY_VERSION': 'fixture', 'OMARCHY_ISO_SHA256': 'fixture',
                       'IMAGE_NAME': 'candidate', 'IMAGE_BUCKET': 'gs://fixture', 'DISK_GB': '40',
                       'IMAGE_DEVICE': '/dev/disk/by-id/google-octogee-image', 'EVIDENCE_WORK': directory,
                       'TEST_DEVICE_BYTES': str(device_bytes), 'TEST_BLOCK': str(int(block_device))},
                capture_output=True, text=True, timeout=10)
            sudo = (Path(directory) / 'sudo').read_text() if (Path(directory) / 'sudo').exists() else ''
            return result, sudo

    def test_attached_disk_of_the_image_size_becomes_the_install_target(self):
        result, sudo = self.prepare(40 * 1024 ** 3)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('DISK=/dev/sdb', result.stdout)
        self.assertIn('chown', sudo)

    def test_missing_image_disk_fails_before_install(self):
        result, sudo = self.prepare(40 * 1024 ** 3, block_device=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('ERROR: image disk /dev/disk/by-id/google-octogee-image is not attached', result.stdout)
        self.assertNotIn('chown', sudo)

    def test_image_disk_of_another_size_fails_before_install(self):
        result, sudo = self.prepare(150 * 1024 ** 3)
        self.assertEqual(result.returncode, 1)
        self.assertIn('ERROR: image disk /dev/sdb is 161061273600 bytes; expected 40 GiB', result.stdout)
        self.assertNotIn('chown', sudo)


class GatewayPreloadTests(unittest.TestCase):
    def preload(self, fail=False, customize=False, scratch_fail=False):
        functions = Path(__file__).with_name('pipeline.sh').read_text().split('mkdir -p "$WORK"', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['bash', '-c', functions + r'''
WORK="$EVIDENCE_WORK"
PAYLOAD="$TEST_PAYLOAD"
guest_started=0
gcloud() { printf '%s' fixture-access-token; }
guest_ssh() {
  printf '%s\n' "$*" >> "$WORK/commands"
  if [[ "$*" == *--initialize-factory* ]]; then cat > "$WORK/scratch-script"; [[ "$TEST_SCRATCH_FAIL" == 0 ]] || return 17; touch "$WORK/scratch-bounded"; fi
  if [[ "$*" == *systemctl\ start\ docker.service* && ! -f "$WORK/scratch-bounded" ]]; then return 1; fi
  if [[ "$*" == *systemctl\ start\ docker.service* && -f "$WORK/home-required" ]]; then
    return 1
  fi
  if [[ "$*" == *bash\ /tmp/customize/customize.sh* ]]; then
    touch "$WORK/home-required"
  fi
  if [[ "$*" == */root/.docker/config.json* ]]; then cat > "$WORK/docker-config"; fi
  if [[ "$*" == *docker\ pull* ]]; then
    cat > "$WORK/pull-input"
    [[ "$TEST_FAIL" == 0 ]] || return 37
  fi
}
tar() { :; }
guest_scp() { :; }
if [[ "$TEST_CUSTOMIZE" == 1 ]]; then customize_guest; else preload_gateway_image; fi
echo PRELOAD_DONE
'''], env={**os.environ, 'OMARCHY_VERSION': 'fixture', 'OMARCHY_ISO_SHA256': 'fixture',
                    'IMAGE_NAME': 'candidate', 'IMAGE_BUCKET': 'gs://fixture', 'DISK_GB': '40',
                    'IMAGE_DEVICE': '/dev/fixture', 'EVIDENCE_WORK': directory, 'TEST_PAYLOAD': str(Path(__file__).resolve().parent),
                    'OCTOGEE_DESKTOP_EDGE_IMAGE': 'us-central1-docker.pkg.dev/octogee/octogee/gateway-edge@sha256:' + 'b' * 64,
                    'OCTOGEE_DESKTOP_GATEWAY_IMAGE': 'us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder@sha256:' + 'a' * 64,
                    'TEST_SCRATCH_FAIL': str(int(scratch_fail)), 'TEST_FAIL': str(int(fail)), 'TEST_CUSTOMIZE': str(int(customize))}, capture_output=True, text=True, timeout=10)
            commands = (Path(directory) / 'commands').read_text() if (Path(directory) / 'commands').exists() else ''
            token = (Path(directory) / 'pull-input').read_text() if (Path(directory) / 'pull-input').exists() else ''
            config = (Path(directory) / 'docker-config').read_text() if (Path(directory) / 'docker-config').exists() else ''
            return result, commands, token, config

    def test_preloads_the_digest_through_the_credential_helper_without_a_stored_login(self):
        result, commands, token, config = self.preload()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('PRELOAD_DONE', result.stdout)
        self.assertIn('systemctl start docker.service', commands)
        self.assertLess(commands.index('install -D -m 0755 /dev/stdin /usr/local/bin/docker-credential-octogee'), commands.index('docker pull'))
        self.assertLess(commands.index('install -D -m 0644 /dev/stdin /root/.docker/config.json'), commands.index('docker pull'))
        self.assertEqual(json.loads(config), {'credHelpers': {'us-central1-docker.pkg.dev': 'octogee'}})
        self.assertIn('export OCTOGEE_REGISTRY_TOKEN="$(cat)";', commands)
        self.assertIn('octogee-gateway-builder@sha256:' + 'a' * 64, commands)
        self.assertIn('docker pull --quiet us-central1-docker.pkg.dev/octogee/octogee/gateway-edge@sha256:' + 'b' * 64, commands)
        self.assertIn('/etc/octogee-gateway-edge-image', commands)
        self.assertIn('docker image inspect', commands)
        self.assertIn('/etc/octogee-gateway-image', commands)
        self.assertNotIn('docker login', commands)
        self.assertNotIn('docker logout', commands)
        self.assertEqual(token, 'fixture-access-token')
        self.assertNotIn('fixture-access-token', commands + result.stdout + result.stderr)

    def test_factory_preloads_before_customization_requires_an_owner_home_disk(self):
        result, commands, token, _ = self.preload(customize=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('PRELOAD_DONE', result.stdout)
        self.assertIn('bash /tmp/customize/customize.sh', commands)
        self.assertIn('docker pull --quiet us-central1-docker.pkg.dev/octogee/octogee/gateway-edge@sha256:' + 'b' * 64, commands)
        self.assertIn('/etc/octogee-gateway-edge-image', commands)
        self.assertIn('docker image inspect', commands)
        self.assertEqual(token, 'fixture-access-token')

    def test_unbounded_scratch_blocks_docker_and_preload(self):
        result, commands, token, _ = self.preload(scratch_fail=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('systemctl start docker.service', commands)
        self.assertEqual(token, '')
        self.assertIn('could not bound disposable scratch', result.stdout)

    def test_failed_preload_stops_the_image_pipeline(self):
        result, _, _, _ = self.preload(fail=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('PRELOAD_DONE', result.stdout)
        self.assertIn('gateway preload failed', result.stdout)


if __name__ == '__main__':
    unittest.main()
