// Produces a candidate document only. Nothing is uploaded or copied into web/public.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function createAssetLinks(applicationId, fingerprint) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.pilot$/.test(applicationId ?? '')) {
    throw new Error('Expected a trial applicationId ending in .pilot');
  }
  if (typeof fingerprint !== 'string' ||
      !/^(?:[a-f\d]{64}|(?:[a-f\d]{2}:){31}[a-f\d]{2})$/i.test(fingerprint)) {
    throw new Error('Expected one SHA-256 certificate fingerprint (64 hex digits)');
  }
  const normalized = fingerprint.replaceAll(':', '').toUpperCase().match(/.{2}/g).join(':');
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: applicationId,
      sha256_cert_fingerprints: [normalized],
    },
  }];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/assetlinks.mjs <certificate-sha256>');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const config = JSON.parse(readFileSync(resolve(root, 'pilot.json'), 'utf8'));
    const candidate = createAssetLinks(config.applicationId, process.argv[2]);
    const destination = resolve(root, 'out/assetlinks.json');
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify(candidate, null, 2) + '\n');
    console.log('Candidate written to android/pilot/out/assetlinks.json; not deployed.');
    console.log('Do not authorize the standard debug certificate on the production origin.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
