"""Root-owned, conservative storage policy for Linux Archive Explorer.

Only app-owned, explicitly named workspaces are eligible. User archives, config,
accounts, unknown recovery formats, and explicitly protected material are NEVER
pruned. These limits intentionally protect machines with modest storage capacity.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time
from typing import Any

MiB = 1024 * 1024
MIN_FREE_BYTES = 512 * MiB
TEMP_LIMIT_BYTES = 256 * MiB        # staging and uploads, separately
TRASH_LIMIT_BYTES = 64 * MiB
EDITS_LIMIT_BYTES = 16 * MiB
RESTORE_SOFT_LIMIT_BYTES = 256 * MiB
TRASH_RETENTION_SECONDS = 12 * 3600
EDITS_RETENTION_SECONDS = 24 * 3600
TRASH_MAX_BUNDLES = 1
EDITS_MAX_BUNDLES = 2
INSTALLER_MAX_BACKUPS = 1
BACKUP_NAME = re.compile(r'^(?:setup-before-v[^/]+|uninstall-before-[0-9-]+)\.tar\.gz$')
BUNDLE_NAME = re.compile(r'^\d{8}-\d{6}-[0-9a-f]{12}$')


def reserve_bytes(total: int) -> int:
    """Preserve 10% on small filesystems, 512 MiB or 10% on normal disks.

    A 128 MiB tmpfs cannot have a 512 MiB reserve; protecting 10% still
    leaves a meaningful floor while allowing tiny file-management operations.
    """
    return max(4 * MiB, total // 10) if total < 5 * 1024 * MiB else max(MIN_FREE_BYTES, total // 10)


def space_available(path: str, needed: int = 0) -> bool:
    usage = shutil.disk_usage(path)
    return usage.free >= reserve_bytes(usage.total) + max(0, needed)


def require_space(path: str, needed: int, operation: str) -> None:
    usage = shutil.disk_usage(path)
    reserve = reserve_bytes(usage.total)
    if usage.free < reserve + max(0, needed):
        raise ValueError(f'Not enough safe free disk space for {operation}; requires {needed} bytes plus {reserve} bytes reserved on this filesystem.')


def immediate_size(path: str) -> int:
    total = 0
    try:
        with os.scandir(path) as scan:
            for x in scan:
                if x.is_file(follow_symlinks=False):
                    total += x.stat(follow_symlinks=False).st_size
    except FileNotFoundError:
        pass
    return total


def content_size(path: str, limit: int | None = None) -> int:
    """Conservative logical size; don't follow symlinks or other mounts."""
    if os.path.islink(path):
        return os.lstat(path).st_size
    if not os.path.isdir(path):
        return os.lstat(path).st_size
    dev = os.lstat(path).st_dev
    total = 0
    count = 0
    for root, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d)) and os.lstat(os.path.join(root, d)).st_dev == dev]
        for name in files:
            child = os.path.join(root, name)
            st = os.lstat(child)
            if stat.S_ISREG(st.st_mode):
                total += st.st_size
            count += 1
            if count > 100_000:
                raise ValueError('Too many files in this item to calculate safe storage usage')
            if limit is not None and total > limit:
                return total
    return total


def _safe_dir(root: str, name: str) -> str | None:
    if os.path.islink(root) or not os.path.isdir(root):
        return None
    child = os.path.join(root, name)
    if os.path.islink(child) or not os.path.isdir(child):
        return None
    return child


def _bundles(root: str, kind: str) -> list[dict[str, Any]]:
    directory = _safe_dir(root, kind)
    if directory is None:
        return []
    out = []
    for ent in os.scandir(directory):
        if not BUNDLE_NAME.fullmatch(ent.name) or not ent.is_dir(follow_symlinks=False):
            continue
        path = ent.path
        meta_file = os.path.join(path, 'metadata.json')
        if os.path.islink(meta_file) or not os.path.isfile(meta_file):
            continue
        try:
            with open(meta_file, encoding='utf-8') as f:
                meta = json.load(f)
            if not isinstance(meta, dict):
                continue
            if os.path.lexists(os.path.join(path, 'protected')):
                continue
            if kind == 'trash' and meta.get('state') != 'trashed':
                continue
            if kind == 'edits':
                backup = str(meta.get('backup_path', ''))
                if os.path.dirname(backup) != path or os.path.islink(backup) or not os.path.isfile(backup):
                    continue
            stamp = int(meta.get('deleted_at', meta.get('created_at', meta.get('prepared_at', 0))))
            size = content_size(path)
            out.append(dict(path=path, name=ent.name, created=stamp, size=size, mtime_ns=ent.stat(follow_symlinks=False).st_mtime_ns))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    return sorted(out, key=lambda x: (x['created'], x['mtime_ns'], x['name']), reverse=True)


def _remove_bundle(path: str, parent: str) -> None:
    # Fixed parent, no symlinks and no traversal. Never delete a mount.
    if os.path.dirname(path) != parent or os.path.islink(path) or os.path.ismount(path):
        raise ValueError('Unsafe cleanup target')
    shutil.rmtree(path)


def prune_safety_bundles(rollback: str, *, reset: bool = False, target: str | None = None) -> dict[str, Any]:
    now = time.time()
    result: dict[str, Any] = {'removed': 0, 'freed_bytes': 0, 'kept_bytes': 0}
    for kind, max_count, quota, age in (('trash', TRASH_MAX_BUNDLES, TRASH_LIMIT_BYTES, TRASH_RETENTION_SECONDS),
                                        ('edits', EDITS_MAX_BUNDLES, EDITS_LIMIT_BYTES, EDITS_RETENTION_SECONDS)):
        if target is not None and kind != target:
            continue
        parent = _safe_dir(rollback, kind)
        if parent is None:
            continue
        count = kept = 0
        for ent in _bundles(rollback, kind):
            expired = now - ent['created'] >= age
            retain = not reset and not expired and count < max_count and kept + ent['size'] <= quota
            if retain:
                count += 1
                kept += ent['size']
                continue
            _remove_bundle(ent['path'], parent)
            result['removed'] += 1
            result['freed_bytes'] += ent['size']
        result[f'{kind}_kept_bytes'] = kept
        result['kept_bytes'] += kept
    return result


def _verified_installer_archive(path: str) -> bool:
    side = path + '.sha256'
    if os.path.islink(path) or os.path.islink(side) or not os.path.isfile(path) or not os.path.isfile(side):
        return False
    try:
        line = Path(side).read_text(encoding='ascii').splitlines()[0]
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or not re.fullmatch('[a-f0-9]{64}', parts[0].lower()):
            return False
        if os.path.basename(parts[1].lstrip('*')) != os.path.basename(path):
            return False
        digest = hashlib.sha256()
        with open(path, 'rb') as fh:
            for block in iter(lambda: fh.read(MiB), b''):
                digest.update(block)
        return digest.hexdigest() == parts[0].lower()
    except (OSError, ValueError, IndexError):
        return False


def prune_installer(rollback: str, *, dry_run: bool = False, keep: int = INSTALLER_MAX_BACKUPS) -> dict[str, Any]:
    parent = _safe_dir(rollback, 'installer')
    if parent is None:
        return {'kept': 0, 'removed': 0, 'unverified': 0, 'freed_bytes': 0}
    known = []
    unexpected = 0
    for ent in os.scandir(parent):
        if ent.is_file(follow_symlinks=False) and BACKUP_NAME.fullmatch(ent.name):
            if _verified_installer_archive(ent.path):
                known.append(ent)
            else:
                unexpected += 1
    known.sort(key=lambda e: (e.stat(follow_symlinks=False).st_mtime, e.name), reverse=True)
    total_removed = freed = 0
    for ent in known[max(0, keep):]:
        size = os.lstat(ent.path).st_size + os.lstat(ent.path + '.sha256').st_size
        if not dry_run:
            os.unlink(ent.path)
            os.unlink(ent.path + '.sha256')
        total_removed += 1
        freed += size
    return {'kept': min(len(known), max(0, keep)), 'removed': total_removed,
            'unverified': unexpected, 'freed_bytes': freed}


def storage_report(root: str) -> dict[str, Any]:
    usage = shutil.disk_usage(root)
    paths = ['staging', 'uploads', 'jobs', 'archives', 'rollback/installer', 'rollback/restore', 'rollback/trash', 'rollback/edits', 'rollback/ui', 'logs']
    sizes = {}
    for sub in paths:
        path = os.path.join(root, sub)
        if os.path.isdir(path) and not os.path.islink(path):
            sizes[sub] = content_size(path)
    # Restore History bundles live directly under rollback/restore-TIMESTAMP-ID,
    # not inside rollback/restore/. Include them in every visible inventory.
    history = os.path.join(root, 'rollback')
    history_bytes = 0
    if os.path.isdir(history) and not os.path.islink(history):
        for ent in os.scandir(history):
            if re.fullmatch(r'restore-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}', ent.name) and ent.is_dir(follow_symlinks=False):
                history_bytes += content_size(ent.path)
    sizes['rollback/restore-history'] = history_bytes
    return {'disk_total': usage.total, 'disk_free': usage.free,
            'required_reserve': reserve_bytes(usage.total),
            'sizes': sizes,
            'limits': {'staging_bytes': TEMP_LIMIT_BYTES, 'uploads_bytes': TEMP_LIMIT_BYTES,
                       'trash_bytes': TRASH_LIMIT_BYTES, 'edits_bytes': EDITS_LIMIT_BYTES,
                       'restore_soft_bytes': RESTORE_SOFT_LIMIT_BYTES,
                       'installer_recovery_count': INSTALLER_MAX_BACKUPS}}


def prune_spool(root: str, jobs: str, *, reset: bool = False, target: str | None = None) -> dict[str, Any]:
    """Remove abandoned spool files, never a job's active input or a recent transfer.

    Manual reset is allowed only after callers have confirmed that no jobs run.
    """
    active: set[str] = set()
    active_ids: set[str] = set()
    running = False
    if os.path.isdir(jobs) and not os.path.islink(jobs):
        for ent in os.scandir(jobs):
            if not ent.is_file(follow_symlinks=False) or not re.fullmatch(r'[a-f0-9]{32}\.json', ent.name):
                continue
            try:
                job = json.loads(Path(ent.path).read_text(encoding='utf-8'))
                if job.get('status') in {'queued','running','scanning','archiving','snapshotting','restoring','rolling-back','verifying', 'copying','moving'}:
                    running = True
                    active_ids.add(ent.name[:-5])
                    for key in ('staged_path', 'upload_path', 'archive_path'):
                        if isinstance(job.get(key), str):
                            active.add(job[key])
            except (OSError, ValueError, TypeError):
                # Unparseable job metadata: refuse manual resets rather than risk
                # deleting an input that could be needed for recovery.
                if reset:
                    raise ValueError('Unreadable job metadata; reset refused')
    if reset and running:
        raise ValueError('Active job exists; reset refused')
    if os.path.lexists(os.path.join(jobs, 'restore.lock')):
        raise ValueError('Restore/rollback lock exists; spool cleanup refused')
    now = time.time()
    result: dict[str, Any] = {'removed': 0, 'freed_bytes': 0, 'deferred_bytes': 0}
    for name, max_age in (('staging', 2 * 3600), ('uploads', 2 * 3600)):
        if target is not None and name != target:
            continue
        directory = _safe_dir(root, name)
        if directory is None:
            continue
        entries = []
        for ent in os.scandir(directory):
            if ent.path in active or any(ent.name.startswith(id + "-") for id in active_ids) or not ent.is_file(follow_symlinks=False) or ent.is_symlink():
                continue
            age = now - ent.stat(follow_symlinks=False).st_mtime
            if not reset and age < max_age:
                continue
            entries.append(ent)
        for ent in entries:
            st = ent.stat(follow_symlinks=False)
            # A browser may still hold a named file open; this is a safe
            # abandoned-file fallback, not an active-download completion signal.
            os.unlink(ent.path)
            result['removed'] += 1
            result['freed_bytes'] += st.st_size
        result[f'{name}_remaining_bytes'] = immediate_size(directory)
        if result[f'{name}_remaining_bytes'] > TEMP_LIMIT_BYTES:
            result['deferred_bytes'] += result[f'{name}_remaining_bytes'] - TEMP_LIMIT_BYTES
    return result


JOB_MAX_BYTES = 10 * MiB
JOB_MAX_RECORDS = 250


def prune_finished_jobs(root: str, *, reset: bool = False) -> dict[str, Any]:
    """Trim completed job metadata, keep history linked to live rollback bundles."""
    jobs = _safe_dir(root, 'jobs')
    if jobs is None:
        return {'removed': 0, 'kept': 0, 'remaining_bytes': 0}
    entries: list[dict[str, Any]] = []
    total = 0
    for ent in os.scandir(jobs):
        if not ent.is_file(follow_symlinks=False) or not re.fullmatch('[a-f0-9]{32}\\.json', ent.name):
            continue
        st = ent.stat(follow_symlinks=False)
        total += st.st_size
        try:
            obj = json.loads(Path(ent.path).read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError):
            continue
        status = str(obj.get('status', ''))
        complete = status in ('completed','failed','warning','cancelled','inspected')
        bundle = str(obj.get('rollback_bundle') or '')
        if bundle and os.path.isdir(bundle):
            continue
        if obj.get('kind') == 'rollback' and status == 'completed':
            # Needed to prevent a repeated rollback of an older restore.
            continue
        if not complete:
            continue
        entries.append({'path': ent.path, 'size': st.st_size, 'mtime': st.st_mtime})
    entries.sort(key=lambda e: e['mtime'])
    removed = 0
    for ent in entries:
        age = time.time()-ent['mtime']
        remaining_count = len(entries)-removed
        if not reset and age < 7*86400 and remaining_count <= JOB_MAX_RECORDS and total <= JOB_MAX_BYTES:
            continue
        os.unlink(ent['path'])
        total -= ent['size']
        removed += 1
    return {'removed': removed, 'remaining_bytes': total}


def reset_legacy_ui(rollback: str) -> dict[str, int]:
    """Remove obsolete app-owned legacy UI recovery snapshots; never touch unrecognized items."""
    ui = _safe_dir(rollback, 'ui')
    if ui is None:
        return {'removed': 0, 'freed_bytes': 0}
    result = {'removed': 0, 'freed_bytes': 0}
    for ent in os.scandir(ui):
        if not ent.is_file(follow_symlinks=False) or not (ent.name.endswith('.tar.gz') or ent.name.endswith('.tar.gz.sha256')):
            continue
        st = ent.stat(follow_symlinks=False)
        os.unlink(ent.path)
        result['removed'] += 1
        result['freed_bytes'] += st.st_size
    return result
