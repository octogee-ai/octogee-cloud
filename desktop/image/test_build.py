import os
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


MOCK_GCLOUD = '''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['BUILD_CALLS'], 'a') as log: log.write(json.dumps(args) + '\\n')
if args[:3] == ['compute', 'instances', 'describe']: sys.exit(1)
if args[:3] == ['compute', 'images', 'create'] and os.environ.get('BUILD_CASE') == 'register-failed':
    print('image create failed', file=sys.stderr); sys.exit(1)
if args[:3] == ['compute', 'instances', 'create'] and os.environ.get('BUILD_CASE') == 'zone-exhausted' and 'us-central1-a' in args:
    print('code: ZONE_RESOURCE_POOL_EXHAUSTED', file=sys.stderr); sys.exit(1)
if args[:3] == ['compute', 'instances', 'create'] and os.environ.get('BUILD_CASE') == 'create-failed':
    print('quota exceeded', file=sys.stderr); sys.exit(1)
if 'ssh' in args and 'tail -n' in args[-1]: print('PIPELINE_DONE')
if 'ssh' in args and 'cat ~/image-build/omarchy-version' in args[-1]: print('4.5.0-2')
'''


class CandidateBuildTests(unittest.TestCase):
    def write_gcloud(self, root):
        gcloud = root / 'gcloud'
        gcloud.write_text(MOCK_GCLOUD)
        gcloud.chmod(0o755)

    def run_build(self, root, extra_args, case='success', run_id='manual'):
        key = root / 'key'
        key.touch()
        (root / "key.pub").write_text("ssh-ed25519 fixture")
        return subprocess.run(['bash', str(Path(__file__).with_name('build.sh')), '--project', 'fixture', *extra_args],
            env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}', 'OCTOGEE_GCE_SSH_KEY': str(key), 'BUILD_CALLS': str(root / 'calls'), 'OCTOGEE_IMAGE_RUN_ID': run_id, 'BUILD_CASE': case, 'OCTOGEE_DESKTOP_EDGE_IMAGE': 'us-central1-docker.pkg.dev/octogee/octogee/gateway-edge@sha256:' + 'b' * 64, 'OCTOGEE_DESKTOP_GATEWAY_IMAGE': 'us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder@sha256:' + 'a' * 64}, capture_output=True, text=True, timeout=10)

    def test_exhausted_zone_falls_back_and_addresses_the_builder_there(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_gcloud(root)
            result = self.run_build(root, ['--zone', 'us-central1-a', '--fallback-zones', 'us-central1-b,us-central1-c'], case='zone-exhausted')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('zone us-central1-a has no capacity', result.stderr)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            creates = [args for args in calls if args[:3] == ['compute', 'instances', 'create']]
            self.assertEqual([args[args.index('--zone') + 1] for args in creates], ['us-central1-a', 'us-central1-b'])
            scp = next(args for args in calls if args[:2] == ['compute', 'scp'])
            self.assertEqual(scp[scp.index('--zone') + 1], 'us-central1-b')

    def test_non_capacity_create_failure_does_not_fall_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_gcloud(root)
            result = self.run_build(root, ['--zone', 'us-central1-a', '--fallback-zones', 'us-central1-b'], case='create-failed')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('quota exceeded', result.stderr)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            self.assertEqual(len([args for args in calls if args[:3] == ['compute', 'instances', 'create']]), 1)

    def test_candidate_does_not_advance_family(self):
        for candidate in [False, True]:
            with self.subTest(candidate=candidate), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.write_gcloud(root)
                result = self.run_build(root, ['--candidate'] if candidate else [], run_id='123-1' if candidate else 'manual')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
                registration = next(args for args in calls if args[:3] == ['compute', 'images', 'create'])
                self.assertEqual('--family' in registration, not candidate)
                builder = next(args for args in calls if args[:3] == ['compute', 'instances', 'create'])
                self.assertEqual('--max-run-duration=2h' in builder, candidate)
                self.assertEqual('--instance-termination-action=DELETE' in builder, candidate)

    def test_image_is_created_from_the_stopped_builders_attached_disk_in_its_zone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_gcloud(root)
            result = self.run_build(root, ['--zone', 'us-central1-a', '--fallback-zones', 'us-central1-b', '--builder-name', 'builder-x', '--image-name', 'image-x'], case='zone-exhausted')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            builder = [args for args in calls if args[:3] == ['compute', 'instances', 'create']][-1]
            self.assertIn('name=builder-x-image,device-name=octogee-image,size=40GB,type=pd-ssd,auto-delete=yes', builder[builder.index('--create-disk') + 1])
            pipeline = next(args for args in calls if 'ssh' in args and 'pipeline.sh' in args[-1])[-1]
            self.assertIn("IMAGE_DEVICE='/dev/disk/by-id/google-octogee-image'", pipeline)
            self.assertIn("DISK_GB='40'", pipeline)
            self.assertIn("OCTOGEE_DESKTOP_GATEWAY_IMAGE='us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder@sha256:" + "a" * 64 + "'", pipeline)
            stop = calls.index(['compute', 'instances', 'stop', 'builder-x', '--zone', 'us-central1-b', '--project', 'fixture', '--quiet'])
            registration = next(i for i, args in enumerate(calls) if args[:3] == ['compute', 'images', 'create'])
            self.assertLess(stop, registration)
            image = calls[registration]
            self.assertEqual(image[image.index('--source-disk') + 1], 'builder-x-image')
            self.assertEqual(image[image.index('--source-disk-zone') + 1], 'us-central1-b')
            self.assertIn('omarchy=4-5-0-2', image[image.index('--labels') + 1])
            self.assertIn('omarchy-iso=4-5-0', image[image.index('--labels') + 1])
            self.assertIn('home-admission=retained-v1', image[image.index('--labels') + 1].split(','))
            self.assertIn('home-restore=gated-v1', image[image.index('--labels') + 1].split(','))
            self.assertNotIn('--source-uri', image)
            delete = calls.index(['compute', 'instances', 'delete', 'builder-x', '--zone', 'us-central1-b', '--project', 'fixture', '--quiet'])
            self.assertGreater(delete, registration)

    def test_failed_registration_still_deletes_the_builder_and_its_image_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_gcloud(root)
            result = self.run_build(root, ['--builder-name', 'builder-x'], case='register-failed')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('image create failed', result.stderr)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            self.assertEqual(calls[-1][:4], ['compute', 'instances', 'delete', 'builder-x'])


if __name__ == '__main__':
    unittest.main()
