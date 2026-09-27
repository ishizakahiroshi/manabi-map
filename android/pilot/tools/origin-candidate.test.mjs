import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createOriginCandidate } from './origin-candidate.mjs';

const input = () => ({
  pilot: { applicationId: 'com.example.school.pilot', startUrl: 'https://legacy.example.com/', appName: 'School pilot' },
  targets: { formatVersion: 1, targets: { 'high-school': { kind: 'high-school-app', origin: 'https://high-school.example.com' } } },
  webManifest: { name: 'Example school', start_url: '/', display: 'standalone', icons: [] },
  fingerprint: 'ab'.repeat(32),
});

test('one selected origin binds pilot, manifest, DAL and authentication while preserving legacy completion', () => {
  const data = input();
  const before = structuredClone(data);
  const result = createOriginCandidate(data);
  assert.deepEqual(data, before);
  assert.equal(result.candidateOnly, true);
  assert.equal(result.pilot.startUrl, 'https://high-school.example.com/');
  assert.equal(result.android.manifestPlaceholders.pilotHost, 'high-school.example.com');
  assert.equal(result.android.manageSpaceUrl, result.pilot.startUrl);
  assert.equal(new URL(result.webManifest.start_url, result.pilot.startUrl).href, result.pilot.startUrl);
  assert.equal(result.android.assetStatements[0].target.site, 'https://high-school.example.com');
  assert.equal(result.digitalAssetLinks.url, 'https://high-school.example.com/.well-known/assetlinks.json');
  assert.equal(result.digitalAssetLinks.document[0].target.package_name, data.pilot.applicationId);
  assert.equal(result.authentication.callbackUrl, 'https://high-school.example.com/auth/callback');
  assert.equal(result.authentication.successReturnUrl, result.pilot.startUrl);
  assert.equal(result.authentication.legacyCallbackUrl, 'https://legacy.example.com/auth/callback');
});

test('rejects a directory target, insecure URLs and ambiguous URL components', () => {
  for (const origin of ['http://high-school.example.com', 'https://school.example.com/high-school', 'https://user@example.com', 'https://example.com:8443', 'https://example.com?code=test', 'https://example.com#token', 'https://example.com/', 'https://EXAMPLE.com']) {
    const data = input();
    data.targets.targets['high-school'].origin = origin;
    assert.throws(() => createOriginCandidate(data));
  }
  const data = input();
  data.targets.targets['high-school'].kind = 'school-directory';
  assert.throws(() => createOriginCandidate(data));
});

test('rejects mismatched Web launch/scope and invalid package/certificate before producing a bundle', () => {
  for (const change of [
    (data) => { data.webManifest.start_url = 'https://legacy.example.com/'; },
    (data) => { data.webManifest.scope = '/schools/'; },
    (data) => { data.pilot.startUrl += '?code=test'; },
    (data) => { data.pilot.applicationId = 'com.example.release'; },
    (data) => { data.fingerprint = 'ab'.repeat(20); },
    (data) => { data.pilot.appName = 'unsafe<name'; },
  ]) {
    const data = input();
    change(data);
    assert.throws(() => createOriginCandidate(data));
  }
});

test('CLI writes a new review bundle and refuses an existing destination without changing input files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'school-origin-candidate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = input();
  const inputs = ['pilot', 'targets', 'webManifest'].map((key) => {
    const path = join(root, `${key}.json`);
    writeFileSync(path, JSON.stringify(data[key]));
    return path;
  });
  const before = inputs.map((path) => readFileSync(path, 'utf8'));
  const output = join(root, 'candidate');
  const args = [fileURLToPath(new URL('./origin-candidate.mjs', import.meta.url)), ...inputs, data.fingerprint, output];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(run().status, 0);
  const candidatePath = join(output, 'origin-candidate.json');
  const produced = readFileSync(candidatePath, 'utf8');
  assert.deepEqual(JSON.parse(produced), createOriginCandidate(data));
  assert.equal(run().status, 1);
  assert.equal(readFileSync(candidatePath, 'utf8'), produced);
  assert.deepEqual(inputs.map((path) => readFileSync(path, 'utf8')), before);
});
