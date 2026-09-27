import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetLinks } from './assetlinks.mjs';

// Synthetic certificate fingerprint and package; never use a device's real data.
const packageName = 'com.example.school.pilot';
const digest = 'ab'.repeat(32);

test('trust document binds exactly one package to the supplied certificate', () => {
  assert.deepEqual(createAssetLinks(packageName, digest), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: [Array(32).fill('AB').join(':')],
    },
  }]);
});

test('accepts keytool colon-separated SHA-256 format', () => {
  assert.deepEqual(createAssetLinks(packageName, Array(32).fill('ab').join(':')),
    createAssetLinks(packageName, digest));
});

test('rejects SHA-1, malformed, empty and multiple certificates', () => {
  for (const bad of ['', 'ab'.repeat(20), digest + '\n' + digest, 'ab:'.repeat(32), 'zz'.repeat(32)]) {
    assert.throws(() => createAssetLinks(packageName, bad));
  }
});

test('does not generate a grant for a non-pilot or wildcard package', () => {
  for (const bad of ['com.example.school', 'com.*.pilot', '', '.pilot', 'com.example.pilot\n']) {
    assert.throws(() => createAssetLinks(bad, digest));
  }
});
