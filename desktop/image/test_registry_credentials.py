import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOTFS = Path(__file__).parent / 'rootfs'
HELPER = ROOTFS / 'usr/local/bin/docker-credential-octogee'
AGENT = ROOTFS / 'usr/local/bin/octo-gateway-agent'
IMAGE = 'us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder@sha256:' + 'a' * 64


def helper(action, token=None, server='us-central1-docker.pkg.dev'):
    env = {key: value for key, value in os.environ.items() if key != 'OCTOGEE_REGISTRY_TOKEN'}
    if token is not None:
        env['OCTOGEE_REGISTRY_TOKEN'] = token
    return subprocess.run(['bash', str(HELPER), action], input=server + '\n', env=env, capture_output=True, text=True)


class CredentialHelperTests(unittest.TestCase):
    def test_rootfs_docker_config_routes_artifact_registry_to_the_shipped_helper(self):
        config = json.loads((ROOTFS / 'root/.docker/config.json').read_text())
        self.assertEqual(config, {'credHelpers': {'us-central1-docker.pkg.dev': 'octogee'}})
        self.assertEqual(HELPER.name, 'docker-credential-' + config['credHelpers']['us-central1-docker.pkg.dev'])
        self.assertTrue(os.access(HELPER, os.X_OK))

    def test_get_answers_with_the_token_handed_to_the_pull(self):
        result = helper('get', token='fixture"quoted\\slashed')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'ServerURL': 'us-central1-docker.pkg.dev', 'Username': 'oauth2accesstoken', 'Secret': 'fixture"quoted\\slashed'})

    def test_get_without_a_token_fails_instead_of_pulling_anonymously(self):
        for token in (None, ''):
            result = helper('get', token=token)
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertEqual(result.stdout, '')
            self.assertIn('OCTOGEE_REGISTRY_TOKEN is not set for us-central1-docker.pkg.dev', result.stderr)
            self.assertNotIn('credentials not found', result.stderr)

    def test_refuses_to_store_or_erase_credentials(self):
        for action in ('store', 'erase'):
            result = helper(action, token='fixture')
            self.assertEqual(result.returncode, 1, action)
            self.assertIn(f'refuses to {action}', result.stderr)

    def test_rejects_unknown_actions(self):
        result = helper('list', token='fixture')
        self.assertEqual(result.returncode, 1)
        self.assertIn("unsupported action 'list'", result.stderr)


class GatewayAgentImagePullTests(unittest.TestCase):
    def ensure_image(self, cached=False, token_fails=False, free_kib=20 * 1024 * 1024):
        body = AGENT.read_text().split('ensure_image() {', 1)[1].split('\nwaiting=0', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state').mkdir()
            docker = root / 'docker'
            docker.write_text('#!/bin/bash\nprintf "%s\\t%s\\n" "$*" "${OCTOGEE_REGISTRY_TOKEN:-}" >> "$RECORD"\n'
                              'if [[ "$1 $2" == "image inspect" && "$TEST_CACHED" == 0 ]]; then exit 1; fi\nexit 0\n')
            docker.chmod(0o755)
            df = root / 'df'
            df.write_text('#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 0 0 %s 0%% /\\n" "$TEST_FREE_KIB"\n')
            df.chmod(0o755)
            script = ('set -euo pipefail\nSTATE_ROOT="$TEST_STATE_ROOT"\n'
                      'meta() { [[ "$TEST_TOKEN_FAILS" == 0 ]] || return 7; printf \'{"access_token":"fixture-token"}\'; }\n'
                      'ensure_image() {' + body + '\nensure_image "$TEST_IMAGE" && echo ENSURED\n')
            result = subprocess.run(['bash', '-c', script], env={
                **os.environ, 'PATH': f'{root}:{os.environ["PATH"]}', 'RECORD': str(root / 'calls'),
                'TEST_STATE_ROOT': str(root / 'state'), 'TEST_IMAGE': IMAGE,
                'TEST_CACHED': str(int(cached)), 'TEST_TOKEN_FAILS': str(int(token_fails)), 'TEST_FREE_KIB': str(free_kib)}, capture_output=True, text=True, timeout=10)
            calls = [line.split('\t') for line in (root / 'calls').read_text().splitlines()] if (root / 'calls').exists() else []
            cache = (root / 'state/gateway-image-cache').read_text() if (root / 'state/gateway-image-cache').exists() else ''
            return result, calls, cache

    def test_pulls_with_the_instance_token_through_the_helper_without_logging_in(self):
        result, calls, cache = self.ensure_image()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ENSURED', result.stdout)
        self.assertEqual([args for args, _ in calls], [f'image inspect {IMAGE}', f'pull -q {IMAGE}'])
        self.assertEqual(dict(calls)[f'pull -q {IMAGE}'], 'fixture-token')
        self.assertNotIn('fixture-token', result.stdout + result.stderr + ''.join(args for args, _ in calls))
        self.assertEqual(cache, IMAGE + '\n')

    def test_cached_image_needs_no_token(self):
        result, calls, _ = self.ensure_image(cached=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [[f'image inspect {IMAGE}', '']])

    def test_unavailable_instance_token_fails_the_pull(self):
        result, calls, cache = self.ensure_image(token_fails=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('ENSURED', result.stdout)
        self.assertEqual([args for args, _ in calls], [f'image inspect {IMAGE}'])
        self.assertEqual(cache, '')

    def test_low_boot_space_refuses_a_new_image_without_affecting_cached_images(self):
        result, calls, cache = self.ensure_image(free_kib=1024 * 1024)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('boot disk', result.stderr)
        self.assertEqual([args for args, _ in calls], [f'image inspect {IMAGE}'])
        self.assertEqual(cache, '')
        cached, calls, _ = self.ensure_image(cached=True, free_kib=0)
        self.assertEqual(cached.returncode, 0, cached.stderr)
        self.assertEqual(calls, [[f'image inspect {IMAGE}', '']])


if __name__ == '__main__':
    unittest.main()
