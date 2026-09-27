// Generate a reviewable migration bundle without changing the installed pilot or Web assets.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssetLinks } from './assetlinks.mjs';

function rootOrigin(value) {
  if (typeof value !== 'string' || value.trim() !== value) throw new Error('Expected an HTTPS origin');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash || value !== url.origin) {
    throw new Error('Expected a canonical HTTPS origin without a path, port or credentials');
  }
  return url.origin;
}

export function createOriginCandidate({ pilot, targets, webManifest, fingerprint }) {
  const target = targets?.targets?.['high-school'];
  if (targets?.formatVersion !== 1 || target?.kind !== 'high-school-app') {
    throw new Error('Expected the high-school-app deployment target');
  }
  const origin = rootOrigin(target.origin);
  const oldUrl = new URL(pilot.startUrl);
  rootOrigin(oldUrl.origin);
  if (pilot.startUrl !== oldUrl.origin + '/') throw new Error('Expected the current pilot root URL');
  if (typeof pilot.appName !== 'string' || !pilot.appName.trim() || /["'&<>\\\r\n]/.test(pilot.appName)) {
    throw new Error('Expected a plain pilot appName');
  }
  if (webManifest?.start_url !== '/' || (webManifest.scope !== undefined && webManifest.scope !== '/')) {
    throw new Error('Expected a root-scoped Web manifest');
  }
  const assetlinks = createAssetLinks(pilot.applicationId, fingerprint);
  const startUrl = origin + '/';
  return {
    formatVersion: 1,
    candidateOnly: true,
    pilot: { ...pilot, startUrl },
    webManifest: { ...webManifest, start_url: '/', scope: '/' },
    android: {
      manifestPlaceholders: { pilotStartUrl: startUrl, pilotHost: new URL(origin).hostname },
      assetStatements: [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'web', site: origin } }],
      manageSpaceUrl: startUrl,
    },
    digitalAssetLinks: { url: origin + '/.well-known/assetlinks.json', document: assetlinks },
    authentication: {
      callbackUrl: origin + '/auth/callback',
      successReturnUrl: startUrl,
      legacyCallbackUrl: oldUrl.origin + '/auth/callback',
      legacyCompletion: 'Complete on the original origin; never transfer code, verifier or session.',
    },
    activationRequirements: [
      'Deploy and verify the high-school origin before updating pilot.json.',
      'Confirm the dedicated pilot signing certificate; never grant the standard debug certificate.',
      'Verify HTTPS DAL without redirects and the effective APK package, host and signing certificate.',
      'Verify Google and LINE callback, cancellation, restart and existing saved data on the target device.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 7) {
      throw new Error('Usage: node origin-candidate.mjs <pilot.json> <deployment-targets.json> <manifest.webmanifest> <certificate-sha256> <new-output-directory>');
    }
    const [pilotPath, targetsPath, manifestPath, fingerprint, destination] = process.argv.slice(2);
    const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
    const candidate = createOriginCandidate({ pilot: json(pilotPath), targets: json(targetsPath), webManifest: json(manifestPath), fingerprint });
    // Existing directories are rejected, so this command cannot replace an active configuration.
    mkdirSync(resolve(destination));
    writeFileSync(resolve(destination, 'origin-candidate.json'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
    console.log('Candidate created. No pilot, Web asset, signing key or external setting was changed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
