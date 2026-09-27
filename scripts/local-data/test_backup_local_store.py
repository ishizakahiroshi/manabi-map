"""Synthetic ciphertext only; no keys, DB, cloud, real UNC or real deletions."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import backup_local_store as store


def cipher(label):
    return b'age-encryption.org/v1\n-> X25519 SYNTHETIC\n--- SYNTHETIC\n' + label.encode()


def meta(**extra):
    return {'created_at': '2026-09-01T00:00:00Z', 'source_kind': 'school', **extra}


def at(value):
    return datetime.fromisoformat(value)


class LocalStoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='synthetic-local-store-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()

    def inventory(self):
        return {p.name: p.read_bytes() if p.is_file() else None for p in self.root.iterdir()}

    def archive(self, label, when, **options):
        return store.archive_generation(self.root, 'school', cipher(label), meta(), now=at(when), **options)

    def test_latest_readback_metadata_and_no_cloud_claim(self):
        raw = cipher('first')
        receipt = store.save_latest(self.root, 'school', raw, meta(
            format='school-sqlite-age-v1', compression='none', table_counts={'schools': 2},
            ciphertext_sha256=hashlib.sha256(raw).hexdigest(), ciphertext_bytes=len(raw)))
        self.assertEqual(receipt['status'], 'saved')
        self.assertEqual(receipt['cloud_sync'], 'unverified')
        self.assertTrue(receipt['readback_verified'])
        self.assertEqual(set(self.inventory()), {'school.latest.age', 'school.latest.json'})
        self.assertEqual((self.root / 'school.latest.age').read_bytes(), raw)
        sidecar = json.loads((self.root / 'school.latest.json').read_bytes())
        self.assertEqual(sidecar['entry']['metadata']['compression'], 'none')
        store.save_latest(self.root, 'school', cipher('next'), meta())
        self.assertEqual((self.root / 'school.latest.age').read_bytes(), cipher('next'))

    def test_public_read_latest_validates_pair_and_preserves_source_metadata(self):
        self.assertIsNone(store.read_latest(self.root, 'school'))
        metadata = meta(schema_version=3, compression='none', source_sha256='f' * 64,
                        recipient_sha256='a' * 64, source_bytes=1024)
        store.save_latest(self.root, 'school', cipher('stable'), metadata)
        before = self.inventory()
        result = store.read_latest(self.root, 'school')
        self.assertEqual(result['payload'], cipher('stable'))
        self.assertEqual(result['metadata'], metadata)
        self.assertTrue(result['receipt']['readback_verified'])
        self.assertEqual(self.inventory(), before)
        (self.root / 'school.latest.age').write_bytes(cipher('changed'))
        with self.assertRaises(store.StoreError):
            store.read_latest(self.root, 'school')

    def test_reloaded_ciphertext_metadata_cannot_disagree_with_verified_bytes(self):
        raw = cipher('same')
        metadata = meta(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw),
                        ciphertext_sha256=hashlib.sha256(raw).hexdigest(), ciphertext_bytes=len(raw))
        store.save_latest(self.root, 'supabase', raw, metadata)
        path = self.root / 'supabase.latest.json'
        original = path.read_bytes()
        for key, wrong in (('sha256', '0' * 64), ('ciphertext_sha256', '0' * 64),
                           ('bytes', len(raw) + 1), ('ciphertext_bytes', len(raw) + 1)):
            value = json.loads(original)
            value['entry']['metadata'][key] = wrong
            path.write_bytes(store._canonical(value))
            with self.assertRaises(store.StoreError):
                store.read_latest(self.root, 'supabase')
        path.write_bytes(original)
        self.assertEqual(store.read_latest(self.root, 'supabase')['payload'], raw)

    def test_failed_second_replace_restores_previous_complete_pair(self):
        store.save_latest(self.root, 'school', cipher('old'), meta())
        before = self.inventory()
        real = os.replace
        calls = 0

        def fail_second(source, target):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('synthetic interrupted metadata replacement')
            return real(source, target)

        with patch.object(store.os, 'replace', side_effect=fail_second):
            with self.assertRaises(OSError):
                store.save_latest(self.root, 'school', cipher('new'), meta())
        self.assertEqual(self.inventory(), before)

    def test_failed_fresh_pair_does_not_leave_incomplete_latest(self):
        real = os.replace

        def fail_metadata(source, target):
            if target.name == 'school.latest.json':
                raise OSError('synthetic failure')
            return real(source, target)

        with patch.object(store.os, 'replace', side_effect=fail_metadata):
            with self.assertRaises(OSError):
                store.save_latest(self.root, 'school', cipher('new'), meta())
        self.assertEqual(self.inventory(), {})

    def test_partial_stage_failure_does_not_touch_previous_or_unrelated(self):
        store.save_latest(self.root, 'school', cipher('old'), meta())
        (self.root / 'unrelated.sqlite').write_bytes(b'SYNTHETIC DO NOT TOUCH')
        before = self.inventory()
        real = store._write

        def fail_write(path, raw, owned=None, rdp_drive=False):
            if owned is not None:
                with path.open('xb') as stream:
                    info = os.fstat(stream.fileno())
                    owned.append((path, info.st_dev, info.st_ino, len(raw), store._digest(raw)))
                    stream.write(raw[:8])
                raise OSError('synthetic partial stage')
            return real(path, raw, owned, rdp_drive)

        with patch.object(store, '_write', side_effect=fail_write):
            with self.assertRaises(OSError):
                store.save_latest(self.root, 'school', cipher('new'), meta())
        self.assertEqual(self.inventory(), before)

    def test_existing_lock_is_not_stolen_or_deleted(self):
        (self.root / '.backup-local-store.lock').write_bytes(b'OTHER SYNTHETIC WRITER')
        before = self.inventory()
        for call in (store.save_latest, store.archive_generation):
            with self.assertRaises(FileExistsError):
                call(self.root, 'school', cipher('new'), meta())
            self.assertEqual(self.inventory(), before)

    def test_stage_name_collision_never_deletes_someone_elses_file(self):
        from types import SimpleNamespace
        staged = self.root / ('.backup-' + 'a' * 32 + '.tmp')
        staged.write_bytes(b'OTHER SYNTHETIC OWNER')
        before = self.inventory()
        with patch.object(store.uuid, 'uuid4', return_value=SimpleNamespace(hex='a' * 32)):
            with self.assertRaises(FileExistsError):
                store.save_latest(self.root, 'school', cipher('new'), meta())
        self.assertEqual(self.inventory(), before)

    def test_directory_reparse_is_refused_before_write(self):
        real = Path.lstat
        from types import SimpleNamespace

        def reparse(path, *args, **kwargs):
            value = real(path, *args, **kwargs)
            if path == self.root:
                return SimpleNamespace(st_mode=value.st_mode, st_file_attributes=1024)
            return value

        with patch.object(Path, 'lstat', reparse):
            with self.assertRaises(store.StoreError):
                store.save_latest(self.root, 'school', cipher('new'), meta())
        self.assertEqual(self.inventory(), {})

    def test_dangling_managed_link_is_not_an_empty_latest_destination(self):
        real_exists, real_guard = store.os.path.lexists, store._unlinked

        def exists(path):
            return path.name == 'school.latest.age' or real_exists(path)

        def reject_link(path, **options):
            if path.name == 'school.latest.age':
                raise store.StoreError('synthetic dangling link')
            return real_guard(path, **options)

        with patch.object(store.os.path, 'lexists', side_effect=exists), patch.object(store, '_unlinked', side_effect=reject_link):
            with self.assertRaises(store.StoreError):
                store.save_latest(self.root, 'school', cipher('new'), meta())
        self.assertEqual(self.inventory(), {})

    def test_name_metadata_age_caps_and_traversal_refused_without_mutation(self):
        invalid = [('../school', cipher('a'), meta()), ('other', cipher('a'), meta()),
            ('school', b'not encrypted synthetic', meta()), ('school', cipher('a'), {}),
            ('school', cipher('a'), meta(password='DO NOT ACCEPT')),
            ('school', cipher('a'), meta(created_at='2026-09-01')),
            ('school', cipher('a'), meta(ciphertext_sha256='0' * 64)),
            ('school', cipher('a'), meta(table_counts={'schools': True})),
            ('school', cipher('a'), meta(schema_version=True)),
            ('school', cipher('a'), meta(compression='unknown'))]
        for name, raw, metadata in invalid:
            with self.subTest(name=name, metadata=metadata):
                with self.assertRaises(store.StoreError):
                    store.save_latest(self.root, name, raw, metadata)
                self.assertEqual(self.inventory(), {})
        with self.assertRaises(store.StoreError):
            store.save_latest(self.root / '..' / self.root.name, 'school', cipher('a'), meta())
        with self.assertRaises(store.StoreError):
            store.save_latest(self.root, 'school', cipher('a'), meta(), max_bytes=24)

    def test_unknown_files_and_other_source_are_preserved(self):
        (self.root / 'unrelated.sqlite').write_bytes(b'SYNTHETIC DATABASE PLACEHOLDER')
        store.save_latest(self.root, 'supabase', cipher('other'), meta(source_kind='supabase'))
        before = self.inventory()
        self.archive('old', '2025-01-01T00:00:00+00:00')
        self.archive('new', '2026-09-28T00:00:00+00:00', apply_retention=True)
        for name, raw in before.items():
            self.assertEqual((self.root / name).read_bytes(), raw)

    def test_duplicate_ciphertext_has_one_physical_object_and_multiple_dates(self):
        one = self.archive('same', '2026-09-27T00:00:00+00:00')
        two = self.archive('same', '2026-09-28T00:00:00+00:00', apply_retention=True)
        self.assertEqual(one['generation_file'], two['generation_file'])
        self.assertEqual(len(list(self.root.glob('*.age'))), 1)
        self.assertEqual(two['retained_records'], 2)
        self.assertEqual(two['retained_payloads'], 1)

    def test_reusing_ciphertext_across_months_preserves_prior_month_slots(self):
        for timestamp in ('2026-07-31T14:00:00+00:00', '2026-08-31T14:00:00+00:00',
                          '2026-09-28T00:00:00+00:00'):
            result = self.archive('same', timestamp, apply_retention=True)
        self.assertEqual(result['retained_records'], 3)
        self.assertEqual(result['retained_payloads'], 1)
        index = json.loads((self.root / 'school.generations.json').read_bytes())
        self.assertEqual([store._time(e['stored_at']).month for e in index['entries']], [7, 8, 9])
        self.assertEqual(result['removed'], [])

    def test_jst_calendar_slots_last_in_each_and_no_padding(self):
        end = at('2026-09-28T00:00:00+09:00')
        entries = []
        begin = at('2026-06-30T12:00:00+09:00')
        for offset in range(90):
            moment = begin + timedelta(days=offset)
            entries.append(store._entry('school', cipher(str(offset)), meta(), moment.isoformat()))
        entries.append(store._entry('school', cipher('current'), meta(), end.isoformat()))
        chosen = store._select(entries, end)
        days = {store._time(e['stored_at']).astimezone(store.JST).date().isoformat() for e in chosen}
        self.assertEqual(days, {'2026-07-31', '2026-08-31', '2026-09-13', '2026-09-20',
            '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'})
        ancient = store._entry('school', cipher('ancient'), meta(), '2025-01-01T00:00:00+00:00')
        self.assertEqual(store._select([ancient], end), [])
        # 15:00 UTC is the new Japanese date; one second earlier is prior day.
        a = store._entry('school', cipher('a'), meta(), '2026-09-27T14:59:59+00:00')
        b = store._entry('school', cipher('b'), meta(), '2026-09-27T15:00:00+00:00')
        self.assertEqual(len(store._select([a, b], end)), 2)

    def test_retention_requires_explicit_flag_and_prunes_only_verified_managed(self):
        old = self.archive('old', '2025-01-01T00:00:00+00:00')
        self.archive('new', '2026-09-28T00:00:00+00:00')
        self.assertTrue((self.root / old['generation_file']).exists())
        result = self.archive('new', '2026-09-28T00:00:00+00:00', apply_retention=True)
        self.assertEqual(result['removed'], [old['generation_file']])
        self.assertFalse((self.root / old['generation_file']).exists())
        self.assertEqual(result['retained_payloads'], 1)

    def test_failed_index_commit_preserves_previous_archive_and_no_prune(self):
        old = self.archive('old', '2025-01-01T00:00:00+00:00')
        before = self.inventory()
        real = os.replace

        def fail_index(source, target):
            if target.name == 'school.generations.json':
                raise OSError('synthetic unavailable target')
            return real(source, target)

        with patch.object(store.os, 'replace', side_effect=fail_index):
            with self.assertRaises(OSError):
                self.archive('new', '2026-09-28T00:00:00+00:00', apply_retention=True)
        self.assertEqual(self.inventory(), before)
        self.assertTrue((self.root / old['generation_file']).exists())

    def test_deletion_failure_keeps_tombstone_and_retries_after_new_verified_copy(self):
        old = self.archive('old', '2025-01-01T00:00:00+00:00')
        real = Path.unlink

        def fail_old(path, *args, **kwargs):
            if path.name == old['generation_file']:
                raise OSError('synthetic offline filesystem')
            return real(path, *args, **kwargs)

        with patch.object(Path, 'unlink', fail_old):
            result = self.archive('new', '2026-09-28T00:00:00+00:00', apply_retention=True)
        self.assertEqual(result['status'], 'archived-prune-incomplete')
        self.assertTrue((self.root / old['generation_file']).exists())
        retry = self.archive('new', '2026-09-28T00:00:00+00:00', apply_retention=True)
        self.assertEqual(retry['removed'], [old['generation_file']])

    def test_corrupt_orphan_and_incomplete_existing_files_are_never_overwritten(self):
        orphan = self.root / ('school.' + 'a' * 64 + '.age')
        orphan.write_bytes(cipher('unknown'))
        before = self.inventory()
        with self.assertRaises(store.StoreError):
            self.archive('new', '2026-09-28T00:00:00+00:00')
        self.assertEqual(self.inventory(), before)
        orphan.unlink()
        (self.root / 'school.latest.age').write_bytes(cipher('unknown'))
        before = self.inventory()
        with self.assertRaises(store.StoreError):
            store.save_latest(self.root, 'school', cipher('new'), meta())
        self.assertEqual(self.inventory(), before)

    def test_hardlink_rejection_preserves_linked_file(self):
        source = self.root / 'unrelated.age'
        source.write_bytes(cipher('unrelated'))
        os.link(source, self.root / 'school.latest.age')
        (self.root / 'school.latest.json').write_bytes(b'{}')
        before = self.inventory()
        with self.assertRaises(store.StoreError):
            store.save_latest(self.root, 'school', cipher('new'), meta())
        self.assertEqual(self.inventory(), before)

    def test_unc_is_opt_in_and_unavailable_mock_never_contacts_network(self):
        # Mock the filesystem read before any possible UNC operation.
        with patch.object(store, '_unlinked', side_effect=OSError('synthetic UNC offline')) as guard:
            with self.assertRaises(store.StoreError):
                store.save_latest(Path('//synthetic-host/share/store'), 'school', cipher('a'), meta())
            guard.assert_not_called()
            with self.assertRaises((OSError, store.StoreError)):
                store.save_latest(Path('//synthetic-host/share/store'), 'school', cipher('a'), meta(), allow_unc=True)
        self.assertEqual(self.inventory(), {})

    def test_explicit_rdp_mode_handles_unstable_ids_and_keeps_full_readback(self):
        from types import SimpleNamespace
        real, observed = Path.lstat, 0

        def unstable(path, *args, **kwargs):
            nonlocal observed
            value = real(path, *args, **kwargs)
            if path.is_relative_to(self.root):
                observed += 1
                return SimpleNamespace(st_mode=value.st_mode, st_file_attributes=getattr(value, 'st_file_attributes', 0),
                    st_nlink=value.st_nlink, st_dev=value.st_dev, st_ino=observed,
                    st_size=value.st_size, st_mtime_ns=value.st_mtime_ns)
            return value

        (self.root / 'probe.age').write_bytes(cipher('same'))
        with patch.object(Path, 'lstat', unstable):
            with self.assertRaises(store.StoreError):
                store._read(self.root / 'probe.age', 1024)
            # Namespace restrictions are separately tested; this mapper keeps
            # all RDP I/O synthetic and local while exercising unstable stats.
            with patch.object(store, '_root', return_value=self.root):
                latest = store.save_latest(r'\\tsclient\Q\synthetic', 'school', cipher('same'), meta(),
                                           allow_unc=True, rdp_drive=True)
                read = store.read_latest(r'\\tsclient\Q\synthetic', 'school', allow_unc=True, rdp_drive=True)
                archived = store.archive_generation(r'\\tsclient\Q\synthetic', 'school', cipher('same'), meta(),
                    allow_unc=True, rdp_drive=True, now=at('2026-09-28T00:00:00+00:00'))
                again = store.archive_generation(r'\\tsclient\Q\synthetic', 'school', cipher('same'), meta(),
                    allow_unc=True, rdp_drive=True, now=at('2026-09-28T00:00:00+00:00'))
        self.assertEqual(latest['metadata_mode'], 'rdp-drive')
        self.assertEqual(read['payload'], cipher('same'))
        self.assertTrue(archived['readback_verified'])
        self.assertEqual(again['retained_payloads'], 1)
        self.assertFalse((self.root / '.backup-local-store.lock').exists())
        self.assertEqual(list(self.root.glob('.backup-*.tmp')), [])

    def test_rdp_mode_requires_explicit_redirected_single_drive_namespace(self):
        for path in (self.root, r'\\synthetic-host\Q\store', r'\\tsclient\QQ\store', r'\\tsclient\share\store'):
            with patch.object(store, '_unlinked') as inspect:
                with self.assertRaises(store.StoreError):
                    store._root(path, True, True)
                inspect.assert_not_called()
        for flag in (None, 1, 'true'):
            with self.assertRaises(store.StoreError):
                store._root(r'\\tsclient\Q\store', True, flag)
        with self.assertRaises(store.StoreError):
            store._root(r'\\tsclient\Q\store', False, True)

    def test_rdp_mode_still_rejects_hash_mismatch_and_retains_unverified_stage(self):
        raw = cipher('expected')
        path = self.root / ('.backup-' + 'a' * 32 + '.tmp')
        path.write_bytes(cipher('modified'))
        entry = store._entry('school', raw, meta(), '2026-09-28T00:00:00+00:00')
        with self.assertRaises(store.StoreError):
            store._verify_payload(path, entry, True)
        with self.assertRaises(store.StoreError):
            store._cleanup(self.root, [(path, 0, 0, len(raw), store._digest(raw))], True)
        self.assertEqual(path.read_bytes(), cipher('modified'))


if __name__ == '__main__':
    unittest.main()
