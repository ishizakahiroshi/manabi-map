r"""Explicit ciphertext stores; no DB, credentials, cloud API or scheduling.

The caller owns an existing dedicated root. Writers cooperate through one lock.
Latest is a two-file commit: ordinary failures restore the previous pair; a
machine crash between replacements is detected as a mismatched pair on reuse.
There is no claim of two-file atomicity, secure erasure or cloud synchronization.
UNC is opt-in; OS network calls can block, so the caller must bound its worker.
RDP drive mode is separately opt-in for \\tsclient\<drive> only: that provider
does not supply stable file IDs. Size/mtime, full readback hashes and the lock
are checked instead; continuously malicious replacement is outside this mode.
Retention uses the current JST calendar day/week/month plus 6/3/2 prior slots,
not the last N populated slots. Weeks begin Monday. Missing slots are not padded.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid


MAX_BYTES = 256 * 1024 * 1024
MAX_JSON = 8 * 1024 * 1024
JST = timezone(timedelta(hours=9))
META_KEYS = {'source_kind', 'source_sha256', 'source_bytes', 'created_at', 'generation',
             'format', 'key', 'last_modified', 'etag', 'sha256', 'bytes', 'table_counts',
             'ciphertext_sha256', 'ciphertext_bytes', 'snapshot_sha256', 'snapshot_bytes', 'compression', 'schema_version',
             'recipient_sha256'}
SHA_KEYS = {'source_sha256', 'sha256', 'ciphertext_sha256', 'snapshot_sha256', 'recipient_sha256'}
BYTE_KEYS = {'source_bytes', 'bytes', 'ciphertext_bytes', 'snapshot_bytes'}


class StoreError(ValueError):
    pass


def _need(condition):
    if not condition:
        raise StoreError('backup store contract rejected')


def _sha(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None


def _digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _canonical(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('ascii')


def _unique(pairs):
    result = {}
    for key, value in pairs:
        _need(key not in result)
        result[key] = value
    return result


def _json(raw):
    _need(len(raw) <= MAX_JSON)
    try:
        return json.loads(raw, object_pairs_hook=_unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(StoreError('invalid JSON')))
    except (UnicodeError, json.JSONDecodeError):
        raise StoreError('invalid backup metadata') from None


def _time(value):
    _need(type(value) is str and 0 < len(value) <= 64)
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise StoreError('invalid backup timestamp') from None
    _need(result.utcoffset() is not None)
    return result.astimezone(timezone.utc)


def _metadata(value):
    _need(type(value) is dict and 'created_at' in value and set(value) <= META_KEYS)
    for key, item in value.items():
        if key in SHA_KEYS:
            _need(_sha(item))
        elif key in BYTE_KEYS:
            _need(type(item) is int and 0 <= item < 2**63)
        elif key == 'table_counts':
            _need(type(item) is dict and 0 < len(item) <= 128)
            for table, count in item.items():
                _need(type(table) is str and re.fullmatch('[a-z][a-z0-9_]{0,62}', table)
                      and type(count) is int and 0 <= count < 2**63)
        elif key == 'compression':
            _need(item in ('none', 'gzip'))
        elif key == 'schema_version':
            _need(type(item) is int and item in (2, 3))
        else:
            _need(type(item) is str and 0 < len(item) <= (1024 if key == 'key' else 128)
                  and all(ord(c) >= 32 and ord(c) != 127 for c in item))
    _time(value['created_at'])
    _need(len(_canonical(value)) <= 32768)
    return _json(_canonical(value))


def _payload(raw, maximum):
    _need(type(maximum) is int and 0 < maximum <= MAX_BYTES)
    _need(type(raw) is bytes and 24 <= len(raw) <= maximum
          and raw.startswith(b'age-encryption.org/v1\n'))


def _unlinked(path, *, directory=False):
    info = path.lstat()
    _need(not stat.S_ISLNK(info.st_mode)
          and not (getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)))
    if directory:
        _need(stat.S_ISDIR(info.st_mode))
    else:
        _need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    return info


def _root(root, allow_unc, rdp_drive=False):
    _need(type(allow_unc) is bool and type(rdp_drive) is bool)
    path = Path(root)
    _need(path.is_absolute() and '..' not in path.parts and path.parent != path)
    is_unc = str(path).startswith(('\\\\', '//'))
    _need(not is_unc or (allow_unc and os.name == 'nt'))
    _need(not rdp_drive or (allow_unc and os.name == 'nt'
          and re.match(r'^\\\\tsclient\\[A-Za-z]\\[^\\]', str(path), re.IGNORECASE)))
    for parent in (*reversed(path.parents), path):
        _unlinked(parent, directory=True)
    resolved = path.resolve(strict=True)
    _need(resolved == path)
    return path


def _inside(root, name):
    _need(type(name) is str and re.fullmatch('[a-zA-Z0-9_.-]+', name)
          and name not in ('.', '..'))
    result = root / name
    _need(result.parent.resolve(strict=True) == root and result.parent == root)
    return result


def _read(path, maximum, rdp_drive=False):
    before = _unlinked(path)
    _need(before.st_size <= maximum)
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        _need(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1)
        if rdp_drive:
            _need((opened.st_size, opened.st_mtime_ns) == (before.st_size, before.st_mtime_ns))
        else:
            _need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
        raw = stream.read(maximum + 1)
    after = _unlinked(path)
    def identity(info):
        tail = (info.st_size, info.st_mtime_ns)
        return tail if rdp_drive else (info.st_dev, info.st_ino, *tail)
    _need(len(raw) <= maximum and identity(before) == identity(after))
    return raw


def _exists(path):
    # Path.exists() hides dangling symlinks; they are not an empty destination.
    present = os.path.lexists(path)
    if present:
        _unlinked(path)
    return present


def _write(path, raw, owned=None, rdp_drive=False):
    with path.open('xb') as stream:
        if owned is not None:
            info = os.fstat(stream.fileno())
            owned.append((path, info.st_dev, info.st_ino, len(raw), _digest(raw)))
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    _need(_read(path, len(raw), rdp_drive) == raw)


@contextmanager
def _locked(root, rdp_drive=False):
    lock = _inside(root, '.backup-local-store.lock')
    token = uuid.uuid4().hex.encode('ascii')
    created = False
    try:
        # A preexisting/stale lock is never stolen or removed.
        with lock.open('xb') as stream:
            created = True
            stream.write(token)
            stream.flush()
            os.fsync(stream.fileno())
        yield
    finally:
        if created:
            _need(_read(lock, 32, rdp_drive) == token)
            lock.unlink()


def _stage(root, raw, owned, rdp_drive=False):
    path = _inside(root, '.backup-' + uuid.uuid4().hex + '.tmp')
    # Register ownership only after exclusive creation, before the first write.
    _write(path, raw, owned, rdp_drive)
    return path


def _cleanup(root, owned, rdp_drive=False):
    for path, device, inode, size, digest in owned:
        _need(path.parent == root and re.fullmatch(r'\.backup-[0-9a-f]{32}\.tmp', path.name))
        if _exists(path):
            _inside(root, path.name)
            info = _unlinked(path)
            if rdp_drive:
                # An incomplete or replaced RDP stage is retained, never guessed
                # to be ours from an unstable inode or filename alone.
                _need(info.st_size == size and _digest(_read(path, size, True)) == digest)
            else:
                _need((info.st_dev, info.st_ino) == (device, inode))
            path.unlink()


def _entry(name, payload, metadata, stamp):
    # Bare sha256/bytes are ciphertext aliases (the R2 producer's vocabulary).
    # Plain source bytes/hash must use source_* or snapshot_* metadata instead.
    for key in ('ciphertext_sha256', 'sha256'):
        if key in metadata:
            _need(metadata[key] == _digest(payload))
    for key in ('ciphertext_bytes', 'bytes'):
        if key in metadata:
            _need(metadata[key] == len(payload))
    return {'name': name, 'ciphertext_sha256': _digest(payload), 'ciphertext_bytes': len(payload),
            'stored_at': stamp, 'metadata': metadata}


def _validate_entry(entry, name):
    _need(type(entry) is dict and set(entry) == {'name', 'ciphertext_sha256', 'ciphertext_bytes', 'stored_at', 'metadata'})
    _need(entry['name'] == name and _sha(entry['ciphertext_sha256'])
          and type(entry['ciphertext_bytes']) is int and 24 <= entry['ciphertext_bytes'] <= MAX_BYTES)
    _time(entry['stored_at'])
    _metadata(entry['metadata'])
    for inner, outer in (('ciphertext_sha256', 'ciphertext_sha256'), ('sha256', 'ciphertext_sha256'),
                         ('ciphertext_bytes', 'ciphertext_bytes'), ('bytes', 'ciphertext_bytes')):
        if inner in entry['metadata']:
            _need(entry['metadata'][inner] == entry[outer])


def _verify_payload(path, entry, rdp_drive=False):
    raw = _read(path, entry['ciphertext_bytes'], rdp_drive)
    _payload(raw, MAX_BYTES)
    _need(len(raw) == entry['ciphertext_bytes'] and _digest(raw) == entry['ciphertext_sha256'])
    return raw


def _latest(root, name, rdp_drive=False):
    data = _inside(root, name + '.latest.age')
    sidecar = _inside(root, name + '.latest.json')
    data_exists, metadata_exists = _exists(data), _exists(sidecar)
    _need(data_exists == metadata_exists)
    if not data_exists:
        return None
    raw_meta = _read(sidecar, MAX_JSON, rdp_drive)
    value = _json(raw_meta)
    _need(type(value) is dict and set(value) == {'format', 'entry'}
          and value['format'] == 'local-age-latest-v1')
    _validate_entry(value['entry'], name)
    return _verify_payload(data, value['entry'], rdp_drive), raw_meta


def _receipt(name, entry, status, **extra):
    return {'name': name, 'status': status, 'ciphertext_sha256': entry['ciphertext_sha256'],
            'ciphertext_bytes': entry['ciphertext_bytes'], 'readback_verified': True,
            'cloud_sync': 'unverified', **extra}


def read_latest(root, name, *, allow_unc=False, rdp_drive=False, max_bytes=MAX_BYTES):
    """Return None or a validated {payload, metadata, receipt}; never decrypt.

    Uses the same cooperative writer lock. A partial/corrupt pair fails rather
    than being treated as missing. This lets producers reuse valid ciphertext
    when a separately compared plaintext/source hash has not changed.
    """
    _need(name in ('school', 'supabase') and type(max_bytes) is int and 0 < max_bytes <= MAX_BYTES)
    root = _root(root, allow_unc, rdp_drive)
    with _locked(root, rdp_drive):
        pair = _latest(root, name, rdp_drive)
        if pair is None:
            return None
        payload, document = pair
        _payload(payload, max_bytes)
        entry = _json(document)['entry']
        return {'payload': payload, 'metadata': entry['metadata'],
                'receipt': _receipt(name, entry, 'read', stored_at=entry['stored_at'],
                                    metadata_mode='rdp-drive' if rdp_drive else 'file-id')}


def save_latest(root, name, payload, metadata, *, allow_unc=False, rdp_drive=False, max_bytes=MAX_BYTES):
    """Save one encrypted latest pair; failure before commit retains old success."""
    _need(name in ('school', 'supabase'))
    _payload(payload, max_bytes)
    metadata = _metadata(metadata)
    root = _root(root, allow_unc, rdp_drive)
    entry = _entry(name, payload, metadata, datetime.now(timezone.utc).isoformat())
    document = _canonical({'format': 'local-age-latest-v1', 'entry': entry})
    data, sidecar = _inside(root, name + '.latest.age'), _inside(root, name + '.latest.json')
    with _locked(root, rdp_drive):
        old = _latest(root, name, rdp_drive)
        owned, replaced = [], []
        try:
            new_data, new_meta = _stage(root, payload, owned, rdp_drive), _stage(root, document, owned, rdp_drive)
            rollback = [_stage(root, raw, owned, rdp_drive) for raw in old] if old else []
            for staging, target in ((new_data, data), (new_meta, sidecar)):
                _root(root, allow_unc, rdp_drive)
                os.replace(staging, target)
                replaced.append(target)
            _need(_latest(root, name, rdp_drive) == (payload, document))
        except BaseException:
            # Preserve backup stages if rollback itself fails; never delete the
            # only old successful bytes in order to make cleanup look complete.
            if replaced:
                if old:
                    for staging, target in zip(rollback, (data, sidecar)):
                        os.replace(staging, target)
                    _need(_latest(root, name, rdp_drive) == old)
                else:
                    for target in reversed(replaced):
                        _inside(root, target.name)
                        _unlinked(target)
                        target.unlink()
            _cleanup(root, owned, rdp_drive)
            raise
        _cleanup(root, owned, rdp_drive)
    return _receipt(name, entry, 'saved', latest_file=data.name, metadata_file=sidecar.name,
                    metadata_mode='rdp-drive' if rdp_drive else 'file-id')


def _generation_path(root, name, sha):
    _need(_sha(sha))
    return _inside(root, name + '.' + sha + '.age')


def _archive(root, name, rdp_drive=False):
    path = _inside(root, name + '.generations.json')
    if not _exists(path):
        value = {'format': 'local-age-generations-v1', 'name': name, 'entries': [], 'retired': []}
        old = None
    else:
        old = _read(path, MAX_JSON, rdp_drive)
        value = _json(old)
        _need(type(value) is dict and set(value) == {'format', 'name', 'entries', 'retired'}
              and value['format'] == 'local-age-generations-v1' and value['name'] == name)
        _need(type(value['entries']) is list and len(value['entries']) <= 10000
              and type(value['retired']) is list and len(value['retired']) <= 10000)
    active, ids, sizes = set(), set(), {}
    for entry in value['entries']:
        _validate_entry(entry, name)
        identity = (entry['stored_at'], entry['ciphertext_sha256'])
        _need(identity not in ids)
        ids.add(identity)
        sha = entry['ciphertext_sha256']
        if sha not in active:
            _verify_payload(_generation_path(root, name, sha), entry, rdp_drive)
            sizes[sha] = entry['ciphertext_bytes']
        _need(sizes[sha] == entry['ciphertext_bytes'])
        active.add(sha)
    _need(all(_sha(sha) for sha in value['retired']) and len(set(value['retired'])) == len(value['retired'])
          and not active.intersection(value['retired']))
    known = active | set(value['retired'])
    for file in root.iterdir():
        match = re.fullmatch(re.escape(name) + r'\.([0-9a-f]{64})\.age', file.name)
        if match:
            _need(match[1] in known)  # Unknown/orphan managed files are preserved and block reuse.
    return value, old


def _select(entries, now):
    current = now.astimezone(JST).date()
    monday = current - timedelta(days=current.weekday())
    month = current.year * 12 + current.month - 1
    slots = {}
    for entry in entries:
        stamp = _time(entry['stored_at'])
        _need(stamp <= now)
        day = stamp.astimezone(JST).date()
        week = day - timedelta(days=day.weekday())
        serial_month = day.year * 12 + day.month - 1
        keys = []
        if 0 <= (current - day).days < 7:
            keys.append(('day', day))
        if 0 <= (monday - week).days < 28:
            keys.append(('week', week))
        if 0 <= month - serial_month < 3:
            keys.append(('month', serial_month))
        rank = (stamp, entry['ciphertext_sha256'])
        for key in keys:
            if key not in slots or rank > slots[key][0]:
                slots[key] = (rank, entry)
    selected = {(entry['stored_at'], entry['ciphertext_sha256']) for _, entry in slots.values()}
    return [entry for entry in entries if (entry['stored_at'], entry['ciphertext_sha256']) in selected]


def archive_generation(root, name, payload, metadata, *, now=None, apply_retention=False,
                       allow_unc=False, rdp_drive=False, max_bytes=MAX_BYTES):
    """Append a verified generation; prune only after explicit successful commit.

    Multiple dates with identical ciphertext share one physical .age file.
    Retired hashes are a durable cleanup ledger: interrupted deletion is retried
    only when apply_retention=True, after verifying the same content again.
    """
    _need(name in ('school', 'supabase') and type(apply_retention) is bool)
    _payload(payload, max_bytes)
    metadata = _metadata(metadata)
    now = datetime.now(timezone.utc) if now is None else now
    _need(type(now) is datetime and now.utcoffset() is not None)
    now = now.astimezone(timezone.utc)
    root = _root(root, allow_unc, rdp_drive)
    entry = _entry(name, payload, metadata, now.isoformat())
    index = _inside(root, name + '.generations.json')
    target = _generation_path(root, name, entry['ciphertext_sha256'])
    with _locked(root, rdp_drive):
        value, old = _archive(root, name, rdp_drive)
        _need(all(_time(item['stored_at']) <= now for item in value['entries']))
        for item in value['entries']:
            if (item['stored_at'], item['ciphertext_sha256']) == (entry['stored_at'], entry['ciphertext_sha256']):
                _need(item == entry)
                break
        else:
            value['entries'].append(entry)
        value['retired'] = [sha for sha in value['retired'] if sha != entry['ciphertext_sha256']]
        if apply_retention:
            selected = _select(value['entries'], now)
            selected_hashes = {item['ciphertext_sha256'] for item in selected}
            expired = {item['ciphertext_sha256'] for item in value['entries']} - selected_hashes
            value['entries'] = selected
            value['retired'] = sorted(set(value['retired']) | expired)
        value['entries'].sort(key=lambda item: (item['stored_at'], item['ciphertext_sha256']))
        _need(len(value['entries']) <= 10000 and len(value['retired']) <= 10000)
        document = _canonical(value)
        _need(len(document) <= MAX_JSON)
        owned, created, committed = [], False, False
        try:
            if _exists(target):
                _need(_verify_payload(target, entry, rdp_drive) == payload)
            else:
                staged_data = _stage(root, payload, owned, rdp_drive)
                os.replace(staged_data, target)
                created = True
            _need(_verify_payload(target, entry, rdp_drive) == payload)
            staged_index = _stage(root, document, owned, rdp_drive)
            previous_index = _stage(root, old, owned, rdp_drive) if old is not None else None
            os.replace(staged_index, index)
            committed = True
            _need(_read(index, MAX_JSON, rdp_drive) == document)
            _archive(root, name, rdp_drive)  # Full active-set readback before any pruning.
        except BaseException:
            if committed:
                if old is not None:
                    os.replace(previous_index, index)
                else:
                    index.unlink()
            if created:
                _need(_verify_payload(target, entry, rdp_drive) == payload)
                target.unlink()
            _cleanup(root, owned, rdp_drive)
            raise
        _cleanup(root, owned, rdp_drive)
        removed, retained_failures = [], []
        if apply_retention:
            for sha in value['retired']:
                retired = _generation_path(root, name, sha)
                if not os.path.lexists(retired):
                    continue
                try:
                    _root(root, allow_unc, rdp_drive)
                    raw = _read(retired, max_bytes, rdp_drive)
                    _payload(raw, max_bytes)
                    _need(_digest(raw) == sha)
                    retired.unlink()  # One checked managed file; never recursive.
                    removed.append(retired.name)
                except (OSError, StoreError):
                    retained_failures.append(retired.name)
    return _receipt(name, entry, 'archived' if not retained_failures else 'archived-prune-incomplete',
                    generation_file=target.name, metadata_file=index.name,
                    retained_records=len(value['entries']), retained_payloads=len({item['ciphertext_sha256'] for item in value['entries']}),
                    removed=removed, prune_incomplete=retained_failures,
                    retention_applied=apply_retention,
                    metadata_mode='rdp-drive' if rdp_drive else 'file-id')
