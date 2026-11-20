#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
import uuid
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    ARCHIVES, CFG, CRITICAL_PREFIXES, JOBS, PRODUCT, ROLLBACK, ROOT, STAGING, UPLOADS, WEB_GID,
    absolute_member, app_error, audit, config_path, disk_free, emit, ensure_runtime_dirs,
    extract_manifest, is_critical, is_internal_runtime, is_pseudo, job_path, list_archive_members, load_job, new_job,
    read_request, save_job, selected_from_manifest, set_job, sha256_file, under, valid_job_id, validate_abs,
    validate_member_name,
)

VERSION = str(CFG.get("version", "0.0.0"))
ALLOWED_SUFFIXES = (".tar.gz", ".tgz", ".tar.zst", ".tzst", ".tar.xz", ".txz", ".tar", ".zip")


def validate_archive_path(value: Any) -> str:
    path = validate_abs(value)
    if is_pseudo(path):
        raise ValueError("runtime virtual filesystems cannot be used for restore archives")
    if not path.lower().endswith(ALLOWED_SUFFIXES):
        raise ValueError("restore file must be a supported tar or ZIP archive")
    try:
        real = os.path.realpath(path, strict=True)
    except (OSError, TypeError) as exc:
        raise ValueError("restore archive does not exist") from exc
    if not os.path.isfile(real):
        raise ValueError("restore archive is not a regular file")
    return real


def _gnu_escape_decode(value: str) -> str:
    """Decode GNU tar --quoting-style=escape output back to a filesystem name."""
    out = bytearray()
    i = 0
    simple = {"a": 7, "b": 8, "f": 12, "n": 10, "r": 13, "t": 9, "v": 11, "\\": 92}
    while i < len(value):
        ch = value[i]
        if ch != "\\":
            out.extend(ch.encode("utf-8", "surrogateescape")); i += 1; continue
        i += 1
        if i >= len(value):
            out.append(92); break
        ch = value[i]
        if ch in simple:
            out.append(simple[ch]); i += 1; continue
        if ch in "01234567":
            digits = ch; i += 1
            while i < len(value) and len(digits) < 3 and value[i] in "01234567":
                digits += value[i]; i += 1
            out.append(int(digits, 8)); continue
        if ch == "x" and i + 2 < len(value) and all(c in "0123456789abcdefABCDEF" for c in value[i+1:i+3]):
            out.append(int(value[i+1:i+3], 16)); i += 3; continue
        out.extend(ch.encode("utf-8", "surrogateescape")); i += 1
    return os.fsdecode(bytes(out))


def _zip_mode(info: zipfile.ZipInfo) -> int:
    return (info.external_attr >> 16) & 0xFFFF


def _zip_is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(_zip_mode(info))


def _scan_zip_security(path: str, selected: list[str], limit: int = 5_000_000) -> tuple[int, int, int]:
    count = 0
    logical = 0
    growth = 0
    symlinks: set[str] = set()
    try:
        with zipfile.ZipFile(path, "r") as zf:
            infos = zf.infolist()
            if len(infos) > limit + 1:
                raise ValueError("archive contains more than 5,000,000 members; restore is refused for safety")
            for info in infos:
                if info.flag_bits & 0x1:
                    raise ValueError("encrypted ZIP archives are not accepted for root restore")
                clean = validate_member_name(info.filename)
                if clean == ".linux-archive-explorer/manifest.json":
                    continue
                absolute = "/" + clean.rstrip("/")
                if not any(under(absolute, root) for root in selected):
                    raise ValueError(f"archive contains a member outside its declared restore paths: {absolute}")
                parts = clean.rstrip("/").split("/")
                for idx in range(1, len(parts)):
                    if "/".join(parts[:idx]) in symlinks:
                        raise ValueError(f"ZIP member is nested beneath an archived symbolic link: {clean}")
                if _zip_is_symlink(info):
                    symlinks.add(clean.rstrip("/"))
                    try:
                        target = zf.read(info)
                    except Exception as exc:
                        raise ValueError(f"unable to read ZIP symlink member: {clean}") from exc
                    if b"\x00" in target or len(target) > 1024 * 1024:
                        raise ValueError(f"unsafe ZIP symbolic link target: {clean}")
                count += 1
                if info.file_size < 0 or info.file_size > (1 << 63) - 1:
                    raise ValueError("archive member size is unreasonably large")
                logical += int(info.file_size)
                if logical > (1 << 63) - 1:
                    raise ValueError("archive logical size is unreasonably large")
                if not info.is_dir() and not _zip_is_symlink(info):
                    old_size = 0
                    try:
                        old = os.lstat(absolute)
                        if stat.S_ISREG(old.st_mode):
                            old_size = int(old.st_size)
                    except OSError:
                        pass
                    growth += max(0, int(info.file_size) - old_size)
                    if growth > (1 << 63) - 1:
                        raise ValueError("archive growth estimate is unreasonably large")
    except zipfile.BadZipFile as exc:
        raise ValueError("ZIP archive is invalid") from exc
    return count, logical, growth


def _scan_archive_security(path: str, selected: list[str], limit: int = 5_000_000) -> tuple[int, int, int]:
    """Stream every archive member; reject path escape or content outside manifest scope.

    The manifest is only metadata, not a trust token.  A fabricated archive that
    merely copies our manifest name must still be unable to restore extra paths.
    """
    if path.lower().endswith(".zip"):
        return _scan_zip_security(path, selected, limit)
    stderr_file = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
    proc = subprocess.Popen(
        ["/usr/bin/tar", "--list", "--quoting-style=escape", "--file", path],
        stdout=subprocess.PIPE, stderr=stderr_file, text=True, errors="replace",
    )
    count = 0
    started = time.monotonic()
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if time.monotonic() - started > 300:
                proc.kill(); raise ValueError("archive security scan exceeded the 5 minute safety limit")
            raw = line.rstrip("\n")
            name = _gnu_escape_decode(raw)
            clean = validate_member_name(name)
            if clean == ".linux-archive-explorer/manifest.json":
                continue
            absolute = "/" + clean
            if not any(under(absolute, root) for root in selected):
                proc.kill()
                raise ValueError(f"archive contains a member outside its declared restore paths: {absolute}")
            count += 1
            if count > limit:
                proc.kill(); raise ValueError("archive contains more than 5,000,000 members; restore is refused for safety")
        rc = proc.wait(timeout=15)
    finally:
        try:
            if proc.poll() is None: proc.kill()
        except Exception:
            pass
    stderr_file.seek(0); err = stderr_file.read(); stderr_file.close()
    if rc != 0:
        raise ValueError((err or "archive listing failed").strip())
    lower = err.lower()
    if "removing leading" in lower or "member name contains '..'" in lower:
        raise ValueError("archive contains unsafe member paths")

    # A second streaming pass calculates the logical payload size without
    # decompressing files to disk. This is conservative for sparse files.
    stderr_file = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
    proc = subprocess.Popen(
        ["/usr/bin/tar", "--list", "--verbose", "--numeric-owner", "--full-time", "--quoting-style=escape", "--file", path],
        stdout=subprocess.PIPE, stderr=stderr_file, text=True, errors="replace",
    )
    logical = 0; growth = 0; started = time.monotonic()
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if time.monotonic() - started > 300:
                proc.kill(); raise ValueError("archive size scan exceeded the 5 minute safety limit")
            fields = line.rstrip("\n").split(None, 5)
            if len(fields) >= 3 and fields[2].isdigit():
                size = int(fields[2]); logical += size
                if logical > (1 << 63) - 1:
                    proc.kill(); raise ValueError("archive logical size is unreasonably large")
                # For regular files, estimate only the additional bytes needed
                # beyond the current file. This is safer and less needlessly
                # restrictive than requiring room for the whole archive twice.
                if len(fields) >= 6 and fields[0].startswith("-"):
                    name = _gnu_escape_decode(fields[5])
                    try:
                        clean = validate_member_name(name)
                    except ValueError:
                        continue
                    if clean == ".linux-archive-explorer/manifest.json":
                        continue
                    target = "/" + clean
                    old_size = 0
                    try:
                        old = os.lstat(target)
                        if stat.S_ISREG(old.st_mode): old_size = int(old.st_size)
                    except OSError:
                        pass
                    growth += max(0, size - old_size)
                    if growth > (1 << 63) - 1:
                        proc.kill(); raise ValueError("archive growth estimate is unreasonably large")
        rc = proc.wait(timeout=15)
    finally:
        try:
            if proc.poll() is None: proc.kill()
        except Exception:
            pass
    stderr_file.seek(0); err2 = stderr_file.read(); stderr_file.close()
    if rc != 0:
        raise ValueError((err2 or "archive size listing failed").strip())
    return count, logical, growth


def _existing_apparent_bytes(selected: list[str], limit_entries: int = 2_000_000) -> tuple[int, bool]:
    """Conservative apparent-byte estimate for the pre-restore safety package.

    Never crosses into a nested filesystem from a selected directory.  The
    estimate is deliberately conservative: sparse files count at logical size.
    """
    total = 0
    seen = 0
    complete = True
    for path in selected:
        if not os.path.lexists(path):
            continue
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISLNK(st.st_mode) or stat.S_ISREG(st.st_mode):
            total += int(st.st_size); seen += 1
            continue
        if not stat.S_ISDIR(st.st_mode):
            seen += 1
            continue
        root_dev = st.st_dev
        for root, dirnames, filenames in os.walk(path, topdown=True, followlinks=False):
            seen += 1
            kept: list[str] = []
            for d in dirnames:
                child = os.path.join(root, d)
                if is_internal_runtime(child) or is_pseudo(child):
                    continue
                try: dst = os.lstat(child)
                except OSError: continue
                if dst.st_dev != root_dev: continue
                kept.append(d)
            dirnames[:] = kept
            for name in filenames:
                child = os.path.join(root, name)
                if is_internal_runtime(child) or is_pseudo(child):
                    continue
                try: fst = os.lstat(child)
                except OSError: continue
                if fst.st_dev != root_dev: continue
                total += int(fst.st_size); seen += 1
                if seen >= limit_entries:
                    complete = False; break
            if not complete or seen >= limit_entries:
                complete = False; break
        if not complete:
            break
    return total, complete


def action_validate_created_archive(req: dict[str, Any]) -> dict[str, Any]:
    """Same manifest and member-scope checks as Restore inspection, with no restore plan.

    Called by the archive worker before it announces success. Accept only the
    current archive job's exact staged artifact; no arbitrary path arguments.
    """
    job_id = str(req.get("job_id", ""))
    if not valid_job_id(job_id):
        raise ValueError("invalid archive job")
    job = load_job(job_id)
    if job.get("kind") != "archive":
        raise ValueError("not an archive creation job")
    expected = os.path.join(STAGING, f"{job_id}-{job['filename']}")
    if os.path.islink(expected) or not os.path.isfile(expected):
        raise ValueError("created archive is not available in protected staging")
    archive = validate_archive_path(expected)
    if archive != expected or os.path.dirname(archive) != STAGING:
        raise ValueError("archive staging path is not canonical")
    manifest = extract_manifest(archive)
    if not manifest or manifest.get("product") != PRODUCT or int(manifest.get("schema", 0)) != 1:
        raise ValueError("created archive is missing a supported restore manifest")
    selected = selected_from_manifest(manifest)
    if selected != job.get("selected_paths"):
        raise ValueError("created archive restore paths differ from the selected files")
    members, _, _ = _scan_archive_security(archive, selected)
    return {"restore_compatible": True, "member_count": members}


def action_inspect(req: dict[str, Any]) -> dict[str, Any]:
    ensure_runtime_dirs()
    archive = validate_archive_path(req.get("path"))
    digest = sha256_file(archive)
    manifest = extract_manifest(archive)
    if manifest is None:
        raise ValueError("This archive does not contain a Linux Archive Explorer restore manifest. It can be inspected, but root restore is disabled for untrusted archives.")
    if manifest.get("product") != PRODUCT or int(manifest.get("schema", 0)) != 1:
        raise ValueError("This archive has an unsupported restore manifest.")
    selected = selected_from_manifest(manifest)
    source_host = str(manifest.get("hostname") or "").strip()
    destination_host = os.uname().nodename
    cross_machine = bool(source_host and source_host.casefold() != destination_host.casefold())
    member_count, logical_bytes, growth_bytes = _scan_archive_security(archive, selected)
    critical = any(is_critical(p) for p in selected)
    existing = sum(1 for p in selected if os.path.lexists(p))
    new_roots = len(selected) - existing
    estimated = int(manifest.get("estimated_source_bytes") or 0)
    existing_bytes, existing_complete = _existing_apparent_bytes(selected)
    # Do not let a single new Restore generate an unbounded rollback package
    # on a small SD card. Existing protected packages remain untouched.
    if existing_complete and existing_bytes > 256 * 1024 * 1024:
        raise ValueError("This restore would require a safety backup larger than the 256 MiB storage limit. No files were changed.")
    free_root = disk_free("/")
    free_rollback = disk_free(ROLLBACK)
    reserve = max(512 * 1024 * 1024, int(shutil.disk_usage("/").total * 0.10))
    # The rollback archive is compressed, but reserve against the apparent size
    # of current data so a worst-case incompressible safety snapshot cannot fill
    # the filesystem. The incoming logical payload gets the same treatment.
    same_fs = os.stat(ROLLBACK).st_dev == os.stat("/").st_dev
    if same_fs:
        required = (existing_bytes if existing_complete else 0) + growth_bytes + reserve
        if free_root < required:
            raise ValueError("not enough free space for the safety backup, restore growth, and filesystem safety reserve")
    else:
        if existing_complete and free_rollback < existing_bytes + reserve:
            raise ValueError("not enough free space to create the required pre-restore safety backup")
        if free_root < growth_bytes + reserve:
            raise ValueError("not enough free space for restore growth while preserving the filesystem safety reserve")
    plan = new_job(
        "restore-plan",
        status="inspected",
        message="Archive inspected and ready for confirmation.",
        archive_path=archive,
        archive_sha256=digest,
        archive_size=os.path.getsize(archive),
        manifest=manifest,
        selected_paths=selected,
        critical=critical,
        cross_machine=cross_machine,
        destination_hostname=destination_host,
        member_count=member_count,
        member_count_truncated=False,
        logical_bytes=logical_bytes,
        growth_bytes=growth_bytes,
        existing_selected_roots=existing,
        missing_selected_roots=new_roots,
        free_root_bytes=free_root,
        free_rollback_bytes=free_rollback,
        existing_apparent_bytes=existing_bytes, existing_size_complete=existing_complete, safety_reserve_bytes=reserve,
        fidelity_warning=("ZIP restore can restore file content, directories, timestamps, basic Unix modes and symlinks, but ZIP does not preserve Linux ownership, ACLs, extended attributes or sparse-file metadata as faithfully as tar formats." if archive.lower().endswith(".zip") else None),
    )
    audit("restore.inspected", plan_id=plan["id"], archive=os.path.basename(archive), sha256=digest, critical=critical, selected_count=len(selected))
    return {
        "plan_id": plan["id"], "archive": os.path.basename(archive), "sha256": digest,
        "size_bytes": os.path.getsize(archive), "manifest": manifest, "selected_paths": selected,
        "critical": critical, "cross_machine": cross_machine, "destination_hostname": destination_host, "member_count": member_count, "member_count_truncated": False, "logical_bytes": logical_bytes, "growth_bytes": growth_bytes,
        "existing_selected_roots": existing, "missing_selected_roots": new_roots,
        "free_root_bytes": free_root, "free_rollback_bytes": free_rollback,
        "existing_apparent_bytes": existing_bytes, "existing_size_complete": existing_complete, "safety_reserve_bytes": reserve,
        "fidelity_warning": ("ZIP restore can restore file content, directories, timestamps, basic Unix modes and symlinks, but ZIP does not preserve Linux ownership, ACLs, extended attributes or sparse-file metadata as faithfully as tar formats." if archive.lower().endswith(".zip") else None),
    }


def action_queue_restore(req: dict[str, Any]) -> dict[str, Any]:
    plan_id = str(req.get("plan_id", ""))
    plan = load_job(plan_id)
    if plan.get("kind") != "restore-plan" or plan.get("status") != "inspected":
        raise ValueError("restore preview is no longer valid; inspect the archive again")
    if time.time() - int(plan.get("updated_at", 0)) > 1800:
        raise ValueError("restore preview expired; inspect the archive again")
    if req.get("confirmed") is not True:
        raise ValueError("restore confirmation is required")
    if (bool(plan.get("critical")) or bool(plan.get("cross_machine"))) and str(req.get("confirmation_text", "")) != "RESTORE":
        raise ValueError("critical or cross-machine restore requires typing RESTORE")
    archive = validate_archive_path(plan.get("archive_path"))
    if sha256_file(archive) != plan.get("archive_sha256"):
        raise ValueError("archive changed after inspection; inspect it again")
    # Only one destructive job can run at a time.
    lock = os.path.join(JOBS, "restore.lock")
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
    os.write(fd, plan_id.encode("ascii", "ignore")); os.close(fd)
    job = new_job(
        "restore",
        plan_id=plan_id,
        archive_path=archive,
        archive_sha256=plan["archive_sha256"],
        selected_paths=plan["selected_paths"],
        manifest=plan["manifest"],
        critical=bool(plan.get("critical")),
        restore_lock=lock,
    )
    try:
        _spawn_safe_worker(str(job["id"]), "restore")
    except Exception:
        try: os.unlink(lock)
        except OSError: pass
        raise
    audit("restore.queued", job_id=job["id"], plan_id=plan_id, critical=job["critical"], archive=os.path.basename(archive))
    return {"job_id": job["id"]}


def _spawn_safe_worker(job_id: str, mode: str) -> None:
    run_base = "/run/linux-archive-explorer"
    os.makedirs(run_base, mode=0o700, exist_ok=True)
    run_dir = os.path.join(run_base, job_id)
    os.makedirs(run_dir, mode=0o700, exist_ok=False)
    src_self = str(Path(__file__).resolve())
    src_common = str(HERE / "common.py")
    dst_self = os.path.join(run_dir, "restore-helper.py")
    dst_common = os.path.join(run_dir, "common.py")
    shutil.copy2(src_self, dst_self); shutil.copy2(src_common, dst_common)
    os.chmod(dst_self, 0o700); os.chmod(dst_common, 0o600)
    subprocess.Popen(
        ["/usr/bin/python3", dst_self, "--worker", mode, job_id, run_dir],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        close_fds=True, start_new_session=True, cwd="/",
        env={**os.environ, "PYTHONPATH": run_dir, "LAE_CONFIG": config_path()},
    )


def _snapshot_db_path(bundle: str) -> str:
    return os.path.join(bundle, "before.sqlite")


def _iter_tree(path: str) -> Iterable[str]:
    if not os.path.lexists(path):
        return
    yield path
    try:
        st = os.lstat(path)
    except OSError:
        return
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
        return
    for root, dirnames, filenames in os.walk(path, topdown=True, followlinks=False):
        dirnames[:] = [d for d in dirnames if not is_internal_runtime(os.path.join(root, d)) and not is_pseudo(os.path.join(root, d))]
        for name in dirnames:
            yield os.path.join(root, name)
        for name in filenames:
            yield os.path.join(root, name)


def _create_snapshot_db(bundle: str, selected: list[str]) -> int:
    db_path = _snapshot_db_path(bundle)
    con = sqlite3.connect(db_path)
    try:
        con.execute("PRAGMA journal_mode=OFF")
        con.execute("PRAGMA synchronous=FULL")
        con.execute("CREATE TABLE paths(path BLOB PRIMARY KEY)")
        count = 0
        batch: list[tuple[bytes]] = []
        for root in selected:
            for path in _iter_tree(root):
                batch.append((os.fsencode(path),))
                count += 1
                if len(batch) >= 5000:
                    con.executemany("INSERT OR IGNORE INTO paths(path) VALUES(?)", batch); con.commit(); batch.clear()
        if batch:
            con.executemany("INSERT OR IGNORE INTO paths(path) VALUES(?)", batch); con.commit()
        return count
    finally:
        con.close()


def _path_existed(con: sqlite3.Connection, path: str) -> bool:
    return con.execute("SELECT 1 FROM paths WHERE path=?", (os.fsencode(path),)).fetchone() is not None


def _safety_backup(bundle: str, selected: list[str]) -> str:
    existing = [p for p in selected if os.path.lexists(p)]
    out = os.path.join(bundle, "before.tar.gz")
    if not existing:
        # Create an empty, valid tar archive.
        subprocess.run(["/usr/bin/tar", "--create", "--gzip", "--file", out, "--files-from", "/dev/null"], check=True)
        with open(out + ".sha256", "w", encoding="ascii") as f:
            f.write(f"{sha256_file(out)}  before.tar.gz\n")
        return out
    list_path = os.path.join(bundle, "before.selection")
    with open(list_path, "wb") as fh:
        for p in existing:
            fh.write(p.lstrip("/").encode("utf-8", "surrogateescape") + b"\0")
    cmd = [
        "/usr/bin/tar", "--create", "--gzip", "--file", out, "--format=pax", "--acls", "--xattrs",
        "--numeric-owner", "--sparse", "--one-file-system", "--null", "--verbatim-files-from", "-C", "/",
    ]
    # GNU tar treats --exclude as positional relative to file operands. Put all
    # exclusions before --files-from so they apply to every selected root.
    for runtime in (JOBS, STAGING, UPLOADS, ROLLBACK, os.path.join(ROOT, "logs")):
        rel = runtime.lstrip("/")
        cmd.extend(["--exclude", rel, "--exclude", rel + "/*"])
    cmd.extend(["--files-from", list_path])
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    if proc.returncode not in (0, 1):
        raise RuntimeError((proc.stderr or "pre-restore safety backup failed").strip())
    verify = subprocess.run(["/usr/bin/tar", "--list", "--file", out], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if verify.returncode != 0:
        raise RuntimeError("pre-restore safety backup could not be verified")
    with open(out + ".sha256", "w", encoding="ascii") as fh:
        fh.write(f"{sha256_file(out)}  before.tar.gz\n")
    os.chmod(out, 0o600); os.chmod(out + ".sha256", 0o600)
    return out


def _apache_touched(selected: list[str]) -> bool:
    return any(under(p, "/etc/apache2") or under("/etc/apache2", p) for p in selected)


def _app_touched(selected: list[str]) -> bool:
    return any(under(p, ROOT) or under(ROOT, p) for p in selected)


def _validate_post_restore(selected: list[str]) -> None:
    if _apache_touched(selected) and shutil.which("apache2ctl"):
        proc = subprocess.run(["apache2ctl", "configtest"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if proc.returncode != 0:
            raise RuntimeError("Apache configuration test failed after restore: " + proc.stdout.strip())
    if _app_touched(selected):
        current = os.path.join(ROOT, "current")
        if os.path.isdir(current):
            for base, _, files in os.walk(current):
                for name in files:
                    if not name.endswith(".php"):
                        continue
                    proc = subprocess.run(["/usr/bin/php", "-l", os.path.join(base, name)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
                    if proc.returncode != 0:
                        raise RuntimeError(f"PHP syntax verification failed after restore: {os.path.join(base, name)}")


def _reload_apache_if_needed(selected: list[str]) -> None:
    if not _apache_touched(selected):
        return
    # Boot recovery runs before Apache starts. Config validation is performed
    # separately; do not try to reload/start Apache from the recovery unit.
    if os.environ.get("LAE_RECOVERY_BOOT") == "1":
        return
    if shutil.which("systemctl"):
        probe = subprocess.run(["systemctl", "is-active", "apache2"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            subprocess.run(["systemctl", "reload", "apache2"], check=True)
            return
    subprocess.run(["apache2ctl", "graceful"], check=True)


def _remove_new_paths(selected: list[str], db_path: str) -> None:
    con = sqlite3.connect(db_path)
    new_dirs: list[str] = []
    try:
        for root in selected:
            if not os.path.lexists(root):
                continue
            for path in _iter_tree(root):
                if _path_existed(con, path):
                    continue
                try:
                    st = os.lstat(path)
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
                    new_dirs.append(path)
                else:
                    try: os.unlink(path)
                    except OSError: pass
        for path in sorted(new_dirs, key=lambda p: p.count("/"), reverse=True):
            try: os.rmdir(path)
            except OSError: pass
    finally:
        con.close()


def _rollback_bundle(bundle: str, selected: list[str]) -> None:
    _verify_rollback_bundle(bundle)
    db_path = _snapshot_db_path(bundle)
    before = os.path.join(bundle, "before.tar.gz")
    if not os.path.isfile(db_path) or not os.path.isfile(before):
        raise RuntimeError("rollback bundle is incomplete")
    _remove_new_paths(selected, db_path)
    proc = subprocess.run([
        "/usr/bin/tar", "--extract", "--file", before, "--directory", "/", "--acls", "--xattrs",
        "--same-owner", "--same-permissions", "--numeric-owner", "--delay-directory-restore",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "rollback extraction failed").strip())
    _validate_post_restore(selected)
    _reload_apache_if_needed(selected)


def _remove_existing_target(path: str) -> None:
    if not os.path.lexists(path):
        return
    st = os.lstat(path)
    if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def _matching_selected_root(target: str, selected: list[str]) -> str:
    candidates = [root for root in selected if target == root or under(target, root)]
    if not candidates:
        raise RuntimeError(f"ZIP restore target escaped selected roots: {target}")
    return max(candidates, key=len)


def _ensure_safe_parent(target: str, selected: list[str]) -> None:
    root = _matching_selected_root(target, selected)
    parent = os.path.dirname(target)
    if target == root:
        return
    rel = os.path.relpath(parent, root)
    current = root
    if rel == ".":
        return
    for part in rel.split(os.sep):
        current = os.path.join(current, part)
        if os.path.lexists(current) and os.path.islink(current):
            raise RuntimeError(f"refusing ZIP restore through existing symbolic-link parent: {current}")


def _zip_timestamp(info: zipfile.ZipInfo) -> float:
    try:
        return time.mktime((*info.date_time, 0, 0, -1))
    except Exception:
        return time.time()


def _restore_zip(archive: str, selected: list[str]) -> None:
    directories: list[tuple[str, int, float]] = []
    try:
        with zipfile.ZipFile(archive, "r") as zf:
            infos = [i for i in zf.infolist() if validate_member_name(i.filename) != ".linux-archive-explorer/manifest.json"]
            infos.sort(key=lambda i: (len(validate_member_name(i.filename).rstrip("/").split("/")), 0 if i.is_dir() else 1, i.filename))
            for info in infos:
                clean = validate_member_name(info.filename)
                target = "/" + clean.rstrip("/")
                _matching_selected_root(target, selected)
                mode = _zip_mode(info)
                perms = stat.S_IMODE(mode) or (0o755 if info.is_dir() else 0o644)
                mtime = _zip_timestamp(info)
                if info.is_dir():
                    if os.path.lexists(target) and (os.path.islink(target) or not os.path.isdir(target)):
                        _remove_existing_target(target)
                    os.makedirs(target, exist_ok=True)
                    directories.append((target, perms, mtime))
                    continue
                _ensure_safe_parent(target, selected)
                os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
                if _zip_is_symlink(info):
                    raw = zf.read(info)
                    link_target = os.fsdecode(raw)
                    if "\x00" in link_target:
                        raise RuntimeError(f"unsafe ZIP symlink target for {target}")
                    _remove_existing_target(target)
                    os.symlink(link_target, target)
                    continue
                if os.path.lexists(target) and (os.path.islink(target) or os.path.isdir(target)):
                    _remove_existing_target(target)
                tmp = os.path.join(os.path.dirname(target), f".lae-restore-{uuid.uuid4().hex}.part")
                try:
                    with zf.open(info, "r") as inf, open(tmp, "xb") as outf:
                        shutil.copyfileobj(inf, outf, 1024 * 1024)
                        outf.flush(); os.fsync(outf.fileno())
                    os.chmod(tmp, perms)
                    os.utime(tmp, (mtime, mtime), follow_symlinks=False)
                    os.replace(tmp, target)
                finally:
                    try: os.unlink(tmp)
                    except FileNotFoundError: pass
            for path, perms, mtime in sorted(directories, key=lambda x: x[0].count("/"), reverse=True):
                if os.path.isdir(path) and not os.path.islink(path):
                    os.chmod(path, perms)
                    os.utime(path, (mtime, mtime), follow_symlinks=False)
    except zipfile.BadZipFile as exc:
        raise RuntimeError("ZIP restore failed because the archive is invalid") from exc


def run_restore_job(job_id: str) -> None:
    job = load_job(job_id)
    lock = str(job.get("restore_lock") or os.path.join(JOBS, "restore.lock"))
    selected = [validate_abs(p) for p in job.get("selected_paths", [])]
    bundle = os.path.join(ROLLBACK, f"restore-{time.strftime('%Y%m%d-%H%M%S')}-{job_id}")
    os.makedirs(bundle, mode=0o700, exist_ok=False)
    try:
        archive = validate_archive_path(job.get("archive_path"))
        if sha256_file(archive) != job.get("archive_sha256"):
            raise RuntimeError("archive checksum changed before restore began")
        set_job(job, "snapshotting", "Creating the pre-restore filesystem snapshot and rollback package.", rollback_bundle=bundle)
        snapshot_count = _create_snapshot_db(bundle, selected)
        safety = _safety_backup(bundle, selected)
        meta = {
            "job_id": job_id, "archive": archive, "archive_sha256": job["archive_sha256"],
            "selected_paths": selected, "snapshot_paths": snapshot_count, "created_at": int(time.time()),
        }
        with open(os.path.join(bundle, "metadata.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=2); fh.write("\n")
        os.chmod(os.path.join(bundle, "metadata.json"), 0o600)
        set_job(job, "restoring", "Restoring verified archive contents to their original Linux paths.")
        if archive.lower().endswith(".zip"):
            _restore_zip(archive, selected)
        else:
            cmd = [
                "/usr/bin/tar", "--extract", "--file", archive, "--directory", "/", "--acls", "--xattrs",
                "--same-owner", "--same-permissions", "--numeric-owner", "--delay-directory-restore",
                "--exclude=.linux-archive-explorer", "--exclude=.linux-archive-explorer/*",
            ]
            proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
            if proc.returncode != 0:
                raise RuntimeError((proc.stderr or "restore extraction failed").strip())
        set_job(job, "verifying", "Verifying restored paths and service configuration.")
        for path in selected:
            if not os.path.lexists(path):
                raise RuntimeError(f"restored selected path is missing: {path}")
        _validate_post_restore(selected)
        _reload_apache_if_needed(selected)
        set_job(job, "completed", "Restore completed and verified. The safety rollback package has been retained.", rollback_bundle=bundle, rollback_archive=safety, snapshot_paths=snapshot_count)
        audit("restore.completed", job_id=job_id, rollback_bundle=bundle, selected_count=len(selected), critical=bool(job.get("critical")))
    except Exception as exc:
        rollback_error = None
        try:
            if os.path.isdir(bundle) and os.path.isfile(os.path.join(bundle, "before.tar.gz")) and os.path.isfile(_snapshot_db_path(bundle)):
                set_job(job, "rolling-back", f"Restore failed: {exc}. Restoring the pre-restore safety snapshot.")
                _rollback_bundle(bundle, selected)
        except Exception as rb:
            rollback_error = str(rb)
        message = f"Restore failed: {exc}"
        if rollback_error:
            message += f"; automatic rollback also failed: {rollback_error}"
        else:
            message += "; the pre-restore safety snapshot was automatically restored."
        set_job(job, "failed", message, error=str(exc), rollback_error=rollback_error, rollback_bundle=bundle)
        audit("restore.failed", job_id=job_id, error=str(exc), rollback_error=rollback_error)
        app_error("restore.failed", job_id=job_id, error=str(exc), rollback_error=rollback_error)
    finally:
        try: os.unlink(lock)
        except OSError: pass


# Restore History is intentionally accessible only by the Linux root account and reads only application-owned job
# records and verified rollback locations. It never scans arbitrary Linux folders.
HISTORY_NAME_RE = re.compile(r"^restore-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$")
RESTORE_RETENTION_DAYS = 7
RESTORE_RETENTION_MAX_COUNT = 2
RESTORE_RETENTION_BYTES = 256 * 1024 * 1024


def _owned_bundle(job: dict[str, Any]) -> str:
    bundle = str(job.get("rollback_bundle") or "")
    if not HISTORY_NAME_RE.fullmatch(os.path.basename(bundle)):
        raise ValueError("invalid restore rollback location")
    if os.path.dirname(bundle) != ROLLBACK or os.path.islink(bundle) or not os.path.isdir(bundle):
        raise ValueError("restore rollback package is unavailable")
    if os.path.realpath(bundle) != bundle:
        raise ValueError("restore rollback path is not canonical")
    meta_path = os.path.join(bundle, "metadata.json")
    if os.path.islink(meta_path) or not os.path.isfile(meta_path):
        raise ValueError("rollback metadata is missing")
    with open(meta_path, "r", encoding="utf-8") as f:
        metadata = json.load(f)
    if str(metadata.get("job_id")) != str(job.get("id")):
        raise ValueError("rollback metadata does not match restore job")
    return bundle


def _rollback_is_done(original_id: str) -> bool:
    try:
        original = load_job(original_id)
        if original.get("rolled_back_at"):
            return True
    except (ValueError, FileNotFoundError):
        pass
    # Existing older rollback jobs do not mark the original, so also search
    # completed rollback job records for backward compatibility.
    for ent in os.scandir(JOBS):
        if not ent.is_file(follow_symlinks=False) or not ent.name.endswith(".json"):
            continue
        try:
            with open(ent.path, "r", encoding="utf-8") as f:
                j = json.load(f)
            if j.get("kind") == "rollback" and j.get("original_restore") == original_id and j.get("status") == "completed":
                return True
        except (ValueError, OSError, TypeError, json.JSONDecodeError):
            continue
    return False


def _bundle_size(bundle: str) -> int:
    total = 0
    for root, dirs, files in os.walk(bundle, followlinks=False):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def _history_entries() -> list[dict[str, Any]]:
    entries = []
    for ent in os.scandir(JOBS):
        if not ent.is_file(follow_symlinks=False) or not ent.name.endswith(".json"):
            continue
        try:
            with open(ent.path, "r", encoding="utf-8") as f:
                job = json.load(f)
            if not isinstance(job, dict) or job.get("kind") != "restore":
                continue
            if not valid_job_id(str(job.get("id", ""))):
                continue
            bundle = _owned_bundle(job)
            before = os.path.join(bundle, "before.tar.gz")
            usable = os.path.isfile(before) and os.path.isfile(_snapshot_db_path(bundle))
            protected = bool(job.get("critical")) or job.get("status") != "completed" or os.path.isfile(os.path.join(bundle, "protected"))
            entries.append({
                "id": str(job["id"]), "created_at": int(job.get("created_at", 0)),
                "status": str(job.get("status", "unknown")),
                "paths": [str(x) for x in job.get("selected_paths", [])][:16],
                "size_bytes": _bundle_size(bundle), "protected": protected,
                "critical": bool(job.get("critical")), "usable": usable,
                "rolled_back": _rollback_is_done(str(job["id"])),
            })
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            continue
    entries.sort(key=lambda e: (e["created_at"], e["id"]), reverse=True)
    return entries


def _verify_rollback_bundle(bundle: str) -> None:
    before = os.path.join(bundle, "before.tar.gz")
    digest_file = before + ".sha256"
    if os.path.islink(before) or os.path.islink(digest_file) or not os.path.isfile(before) or not os.path.isfile(digest_file):
        raise RuntimeError("rollback archive or its SHA-256 record is missing")
    with open(digest_file, "r", encoding="ascii") as f:
        recorded = f.readline().split()[0].lower()
    if not re.fullmatch(r"[a-f0-9]{64}", recorded) or sha256_file(before) != recorded:
        raise RuntimeError("rollback SHA-256 verification failed")
    if not os.path.isfile(_snapshot_db_path(bundle)):
        raise RuntimeError("rollback filesystem snapshot is missing")
    verified = subprocess.run(["/usr/bin/tar", "--list", "--file", before],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if verified.returncode != 0:
        raise RuntimeError("rollback TAR integrity verification failed")


def action_history(_: dict[str, Any]) -> dict[str, Any]:
    return {"history": _history_entries(), "retention_days": RESTORE_RETENTION_DAYS,
            "retention_count": RESTORE_RETENTION_MAX_COUNT,
            "retention_bytes": RESTORE_RETENTION_BYTES}


def action_history_verify(req: dict[str, Any]) -> dict[str, Any]:
    job = load_job(str(req.get("job_id", "")))
    if job.get("kind") != "restore":
        raise ValueError("not a restore history item")
    bundle = _owned_bundle(job)
    _verify_rollback_bundle(bundle)
    audit("restore.history_verified", job_id=job["id"])
    return {"verified": True, "job_id": job["id"]}


def action_history_protect(req: dict[str, Any]) -> dict[str, Any]:
    job = load_job(str(req.get("job_id", "")))
    if job.get("kind") != "restore":
        raise ValueError("not a restore history item")
    bundle = _owned_bundle(job)
    protect = req.get("protected") is True
    marker = os.path.join(bundle, "protected")
    if not protect and (job.get("critical") or job.get("status") != "completed"):
        raise ValueError("critical or failed recovery packages cannot be unprotected")
    if protect:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.close(fd)
    elif os.path.isfile(marker) and not os.path.islink(marker):
        os.unlink(marker)
    audit("restore.history_protection", job_id=job["id"], protected=protect)
    return {"protected": protect}


def action_history_delete(req: dict[str, Any]) -> dict[str, Any]:
    if str(req.get("confirmation_text", "")) != "DELETE":
        raise ValueError("type DELETE to remove this rollback package")
    if os.path.exists(os.path.join(JOBS, "restore.lock")):
        raise ValueError("cannot delete a rollback during an active restore or rollback")
    job = load_job(str(req.get("job_id", "")))
    if job.get("kind") != "restore" or job.get("status") != "completed":
        raise ValueError("only completed restore packages can be deleted")
    bundle = _owned_bundle(job)
    if job.get("critical") or os.path.lexists(os.path.join(bundle, "protected")):
        raise ValueError("unprotect this package before deleting it; critical packages remain protected")
    # Never delete a bundle in use by an active job, even if the lock vanished.
    for ent in os.scandir(JOBS):
        if not ent.is_file(follow_symlinks=False) or not ent.name.endswith(".json"):
            continue
        try:
            with open(ent.path, "r", encoding="utf-8") as f:
                other = json.load(f)
            if other.get("rollback_bundle") == bundle and other.get("status") not in ("completed", "failed"):
                raise ValueError("rollback package is in use")
        except (OSError, json.JSONDecodeError):
            continue
    shutil.rmtree(bundle)
    job["rollback_deleted_at"] = int(time.time())
    save_job(job)
    audit("restore.history_deleted", job_id=job["id"])
    return {"deleted": True}


def prune_restore_history(*, reset: bool = False) -> dict[str, Any]:
    # A restore in flight can still need an older rollback package; skip the
    # entire prune while the protected restore lock exists.
    if os.path.exists(os.path.join(JOBS, "restore.lock")):
        return {"pruned": 0, "skipped_active_restore": True}
    now = int(time.time())
    entries = _history_entries()
    kept = 0
    kept_bytes = 0
    removed = 0
    for entry in entries:
        if entry["protected"] or not entry["usable"] or entry["status"] != "completed":
            continue
        age = now - entry["created_at"]
        # Keep the latest completed restore for at least 24 hours, even if it
        # exceeds the soft quota. Older unprotected packages are quota-bound.
        retain = (not reset and age < RESTORE_RETENTION_DAYS * 86400 and
                  kept < RESTORE_RETENTION_MAX_COUNT and
                  (kept_bytes + entry["size_bytes"] <= RESTORE_RETENTION_BYTES or kept == 0))
        if retain:
            kept += 1; kept_bytes += entry["size_bytes"]
            continue
        try:
            job = load_job(entry["id"])
            bundle = _owned_bundle(job)
            if os.path.lexists(os.path.join(bundle, "protected")):
                continue
            shutil.rmtree(bundle)
            job["rollback_deleted_at"] = now
            save_job(job)
            audit("restore.history_auto_pruned", job_id=job["id"], size=entry["size_bytes"])
            removed += 1
        except (OSError, ValueError):
            continue
    return {"pruned": removed, "retained_bytes": kept_bytes}


def action_queue_rollback(req: dict[str, Any]) -> dict[str, Any]:
    original_id = str(req.get("job_id", ""))
    original = load_job(original_id)
    if original.get("kind") != "restore" or original.get("status") != "completed":
        raise ValueError("only a completed restore can be rolled back")
    if _rollback_is_done(original_id):
        raise ValueError("this restore has already been rolled back")
    bundle = str(original.get("rollback_bundle") or "")
    bundle = _owned_bundle(original)
    if req.get("confirmed") is not True or str(req.get("confirmation_text", "")) != "ROLLBACK":
        raise ValueError("rollback requires typing ROLLBACK")
    lock = os.path.join(JOBS, "restore.lock")
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640); os.close(fd)
    job = new_job("rollback", original_restore=original_id, rollback_bundle=bundle, selected_paths=original["selected_paths"], restore_lock=lock)
    try:
        _spawn_safe_worker(str(job["id"]), "rollback")
    except Exception:
        try: os.unlink(lock)
        except OSError: pass
        raise
    audit("restore.rollback_queued", job_id=job["id"], original_restore=original_id)
    return {"job_id": job["id"]}


def run_rollback_job(job_id: str) -> None:
    job = load_job(job_id)
    lock = str(job.get("restore_lock") or os.path.join(JOBS, "restore.lock"))
    selected = [validate_abs(p) for p in job.get("selected_paths", [])]
    bundle = str(job.get("rollback_bundle"))
    try:
        set_job(job, "rolling-back", "Restoring the pre-restore safety snapshot.")
        _rollback_bundle(bundle, selected)
        set_job(job, "completed", "Rollback completed and verified.")
        original = load_job(str(job.get("original_restore")))
        original["rolled_back_at"] = int(time.time())
        save_job(original)
        audit("restore.rollback_completed", job_id=job_id, original_restore=job.get("original_restore"))
    except Exception as exc:
        set_job(job, "failed", f"Rollback failed: {exc}", error=str(exc))
        audit("restore.rollback_failed", job_id=job_id, error=str(exc))
        app_error("restore.rollback_failed", job_id=job_id, error=str(exc))
    finally:
        try: os.unlink(lock)
        except OSError: pass



def recover_interrupted_jobs() -> int:
    """Recover destructive jobs interrupted by a reboot/power loss.

    Restore jobs are never resumed blindly. If a complete pre-restore safety
    snapshot exists, restore that snapshot. If interruption happened before
    the snapshot completed, mark the job failed and clear the stale lock.
    Interrupted rollback jobs are safely re-run from their preserved bundle.
    """
    ensure_runtime_dirs()
    recovered = 0
    active = {"queued", "snapshotting", "restoring", "verifying", "rolling-back"}
    try:
        names = sorted(os.listdir(JOBS))
    except FileNotFoundError:
        names = []
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(JOBS, name)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                job = json.load(fh)
        except Exception:
            continue
        if not isinstance(job, dict) or str(job.get("status", "")) not in active:
            continue
        kind = str(job.get("kind", ""))
        if kind not in {"restore", "rollback"}:
            continue
        job_id = str(job.get("id") or name[:-5])
        if not valid_job_id(job_id):
            continue
        lock = str(job.get("restore_lock") or os.path.join(JOBS, "restore.lock"))
        selected = [validate_abs(p) for p in job.get("selected_paths", [])]
        bundle = str(job.get("rollback_bundle") or "")
        complete = bool(bundle and under(bundle, ROLLBACK) and os.path.isfile(os.path.join(bundle, "before.tar.gz")) and os.path.isfile(_snapshot_db_path(bundle)))
        try:
            if kind == "rollback" and complete:
                set_job(job, "rolling-back", "Resuming safety rollback after an interrupted shutdown.")
                _rollback_bundle(bundle, selected)
                set_job(job, "completed", "Rollback completed during boot recovery after an interrupted shutdown.")
                audit("restore.boot_recovery_rollback_completed", job_id=job_id)
                recovered += 1
            elif kind == "restore" and complete:
                set_job(job, "rolling-back", "Restore was interrupted by shutdown; restoring the pre-restore safety snapshot before web service starts.")
                _rollback_bundle(bundle, selected)
                set_job(job, "failed", "Restore was interrupted by shutdown. The pre-restore safety snapshot was restored automatically during boot recovery.", rollback_bundle=bundle)
                audit("restore.boot_recovery_restored_snapshot", job_id=job_id, rollback_bundle=bundle)
                recovered += 1
            else:
                set_job(job, "failed", "Restore/rollback was interrupted before a complete safety snapshot was available. No automatic live-filesystem rollback was attempted.")
                audit("restore.boot_recovery_no_snapshot", job_id=job_id, kind=kind)
                recovered += 1
        except Exception as exc:
            set_job(job, "failed", f"Boot recovery failed: {exc}", recovery_error=str(exc), rollback_bundle=bundle)
            audit("restore.boot_recovery_failed", job_id=job_id, error=str(exc))
            app_error("restore.boot_recovery_failed", job_id=job_id, error=str(exc))
        finally:
            try:
                if under(lock, JOBS): os.unlink(lock)
            except OSError:
                pass
    # A stale lock can remain if shutdown occurred before the job JSON was
    # durably created. Clearing it at boot is safe because no pre-boot worker
    # can survive the reboot.
    stale_lock = os.path.join(JOBS, "restore.lock")
    try:
        os.unlink(stale_lock)
    except OSError:
        pass
    return recovered

def web_main() -> None:
    ensure_runtime_dirs()
    req = read_request()
    action = str(req.pop("action", ""))
    if action == "validate-created-archive":
        result = action_validate_created_archive(req)
    elif action == "inspect":
        result = action_inspect(req)
    elif action == "queue-restore":
        result = action_queue_restore(req)
    elif action == "queue-rollback":
        result = action_queue_rollback(req)
    elif action == "history":
        result = action_history(req)
    elif action == "history-verify":
        result = action_history_verify(req)
    elif action == "history-protect":
        result = action_history_protect(req)
    elif action == "history-delete":
        result = action_history_delete(req)
    else:
        raise ValueError("unsupported restore helper action")
    emit({"ok": True, **result})


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--prune":
        if os.geteuid() != 0 and os.environ.get("LAE_DEV") != "1":
            raise SystemExit("restore history pruning requires root")
        print(json.dumps({"ok": True, **prune_restore_history()}), flush=True)
        return
    if len(sys.argv) == 2 and sys.argv[1] == "--prune-reset":
        if os.geteuid() != 0 and os.environ.get("LAE_DEV") != "1":
            raise SystemExit("restore reset cleanup requires root")
        print(json.dumps({"ok": True, **prune_restore_history(reset=True)}), flush=True)
        return
    if len(sys.argv) == 2 and sys.argv[1] == "--recover":
        if os.geteuid() != 0 and os.environ.get("LAE_DEV") != "1":
            raise SystemExit("restore recovery requires root")
        count = recover_interrupted_jobs()
        print(json.dumps({"ok": True, "recovered_jobs": count}), flush=True)
        return
    if len(sys.argv) == 5 and sys.argv[1] == "--worker":
        if os.geteuid() != 0 and os.environ.get("LAE_DEV") != "1":
            raise SystemExit("restore worker requires root")
        mode, job_id, run_dir = sys.argv[2], sys.argv[3], sys.argv[4]
        try:
            if mode == "restore":
                run_restore_job(job_id)
            elif mode == "rollback":
                run_rollback_job(job_id)
            else:
                raise ValueError("invalid worker mode")
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)
        return
    if len(sys.argv) != 1:
        raise SystemExit("command-line arguments are not accepted")
    try:
        web_main()
    except SystemExit:
        raise
    except FileExistsError:
        print(json.dumps({"ok": False, "error": "another restore or rollback is already running"}), flush=True)
        raise SystemExit(1)
    except ValueError as exc:
        # Invalid/unsafe user input is a controlled refusal, not an application failure.
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        raise SystemExit(1)
    except Exception as exc:
        app_error("restore-helper.error", error=str(exc))
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
