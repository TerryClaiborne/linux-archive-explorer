#!/usr/bin/env python3
from __future__ import annotations

import configparser
import json
from itertools import islice
import os
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import uuid
import time
import zipfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    ARCHIVES, CFG, CONFIG_LOAD_ERROR, FORMATS, JOBS, KNOWN_SUFFIXES, LOGS, PRODUCT, RECOVERY, ROOT, ROLLBACK, STAGING, UPLOADS, WEB_GID,
    absolute_member, app_error, atomic_json, audit, config_path, disk_free, emit, ensure_runtime_dirs,
    fsync_copy, is_critical, is_internal_runtime, is_pseudo, job_path, list_archive_members, load_job, new_job,
    os_release, owner_names, public_system_info, read_request, safe_archive_name, save_job, set_job,
    sha256_file, under, validate_abs, validate_member_name, write_log,
)

from storage_policy import (TEMP_LIMIT_BYTES, TRASH_LIMIT_BYTES, EDITS_LIMIT_BYTES, RESTORE_SOFT_LIMIT_BYTES,
                            immediate_size, require_space, content_size, prune_safety_bundles, prune_installer, prune_spool, prune_finished_jobs)

VERSION = str(CFG.get("version", "0.0.0"))
MAX_ESTIMATE_ENTRIES = 500_000
MAX_EDITOR_BYTES = 5 * 1024 * 1024


def validate_browse_dir(path: Any) -> tuple[str, str]:
    clean = validate_abs(path)
    try:
        real = os.path.realpath(clean, strict=True)
    except (OSError, TypeError) as exc:
        raise ValueError(f"folder does not exist: {clean}") from exc
    # Virtual filesystems (/proc, /sys, /dev, /run) are read-browsable so an
    # Administrator can inspect the machine like a normal Linux file manager.
    # Selection and mutating operations remain blocked separately.
    if not os.path.isdir(real):
        raise ValueError("path is not a directory")
    return clean, real


def selectable_path(path: str) -> bool:
    if path == "/" or is_pseudo(path) or is_internal_runtime(path):
        return False
    return True


def validate_source(path: Any) -> str:
    clean = validate_abs(path)
    if not selectable_path(clean):
        raise ValueError(f"this runtime/internal path cannot be archived: {clean}")
    try:
        os.lstat(clean)
    except FileNotFoundError as exc:
        raise ValueError(f"selected item no longer exists: {clean}") from exc
    return clean


def validate_destination(path: Any) -> str:
    clean = validate_abs(path)
    try:
        real = os.path.realpath(clean, strict=True)
    except (OSError, TypeError) as exc:
        raise ValueError("archive destination does not exist") from exc
    if not os.path.isdir(real):
        raise ValueError("archive destination must be a directory")
    if is_pseudo(real) or under(real, STAGING) or under(real, JOBS) or under(real, UPLOADS):
        raise ValueError("that directory cannot be used as an archive destination")
    return real


def action_list_dir(req: dict[str, Any]) -> dict[str, Any]:
    requested, real = validate_browse_dir(req.get("path", "/"))
    dirs_only = bool(req.get("dirs_only", False))
    entries: list[dict[str, Any]] = []
    try:
        scan = list(os.scandir(real))
    except PermissionError as exc:
        raise ValueError("permission denied while reading folder") from exc
    scan.sort(key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.casefold()))
    for ent in scan:
        display_path = requested.rstrip("/") + "/" + ent.name if requested != "/" else "/" + ent.name
        try:
            st = ent.stat(follow_symlinks=False)
        except OSError:
            continue
        is_dir = stat.S_ISDIR(st.st_mode)
        if dirs_only and not is_dir:
            continue
        real_entry = os.path.realpath(ent.path)
        pseudo = is_pseudo(display_path) or is_pseudo(real_entry)
        internal = is_internal_runtime(display_path) or is_internal_runtime(real_entry)
        user, group = owner_names(st)
        entries.append({
            "name": ent.name,
            "is_dir": is_dir,
            "is_symlink": stat.S_ISLNK(st.st_mode),
            "is_regular": stat.S_ISREG(st.st_mode),
            "size": None if is_dir else int(st.st_size),
            "modified": int(st.st_mtime),
            "mode": stat.filemode(st.st_mode),
            "owner": user,
            "group": group,
            "selectable": selectable_path(display_path) and not pseudo and not internal,
            "browsable": is_dir,
            # protected means virtual/non-mutable, not non-browsable. Managed
            # LAE workspaces are browseable; their root folders stay non-selectable.
            "protected": pseudo,
            "managed": internal,
        })
    return {"path": requested, "real_path": real, "entries": entries}



# Search is a bounded browse operation, not an unrestricted root filesystem crawler.
# Directories with different device IDs can be searched by opening them explicitly.
MAX_SEARCH_RESULTS = 250
MAX_SEARCH_SCANNED = 50_000
MAX_SEARCH_DIRS = 1_500
MAX_SEARCH_SECONDS = 8.0


def action_search_dir(req: dict[str, Any]) -> dict[str, Any]:
    requested, real = validate_browse_dir(req.get("path", "/"))
    query = req.get("query", "")
    if not isinstance(query, str) or not 2 <= len(query.strip()) <= 100 or "\x00" in query:
        raise ValueError("search text must contain 2 to 100 characters")
    needle = query.strip().casefold()
    if is_internal_runtime(real) or is_pseudo(real):
        raise ValueError("search cannot enter application workspaces or virtual filesystems")
    root_dev = os.stat(real).st_dev
    pending = [(requested, real)]
    results: list[dict[str, Any]] = []
    visited_dirs = 0
    scanned = 0
    partial = False
    deadline = time.monotonic() + MAX_SEARCH_SECONDS
    while pending:
        if (len(results) >= MAX_SEARCH_RESULTS or scanned >= MAX_SEARCH_SCANNED
                or visited_dirs >= MAX_SEARCH_DIRS or time.monotonic() > deadline):
            partial = True
            break
        display_dir, filesystem_dir = pending.pop()
        visited_dirs += 1
        try:
            with os.scandir(filesystem_dir) as iterator:
                # Cap directory enumeration too: one huge folder must not exhaust RAM.
                entries = sorted(islice(iterator, MAX_SEARCH_SCANNED - scanned), key=lambda e: e.name.casefold())
                truncated_dir = next(iterator, None) is not None
        except (PermissionError, FileNotFoundError, NotADirectoryError, OSError):
            continue
        for ent in entries:
            scanned += 1
            if scanned > MAX_SEARCH_SCANNED or time.monotonic() > deadline:
                partial = True
                break
            child = pathJoin_search(display_dir, ent.name)
            try:
                st = ent.stat(follow_symlinks=False)
                real_child = os.path.realpath(ent.path)
            except (OSError, ValueError):
                continue
            if is_pseudo(child) or is_pseudo(real_child) or is_internal_runtime(child) or is_internal_runtime(real_child):
                continue
            is_dir = stat.S_ISDIR(st.st_mode)
            # Do not follow symlinks, mounted filesystems, or special devices.
            if needle in ent.name.casefold():
                results.append({
                    "name": ent.name, "path": child, "parent": display_dir,
                    "is_dir": is_dir, "is_symlink": stat.S_ISLNK(st.st_mode),
                    "size": None if is_dir else int(st.st_size),
                    "modified": int(st.st_mtime),
                })
                if len(results) >= MAX_SEARCH_RESULTS:
                    partial = True
                    break
            if is_dir and st.st_dev == root_dev:
                pending.append((child, ent.path))
        if truncated_dir:
            partial = True
        if partial:
            break
    return {
        "path": requested, "query": query.strip(), "entries": results,
        "partial": partial, "scanned": scanned, "directories": visited_dirs,
        "limit": MAX_SEARCH_RESULTS,
    }


def pathJoin_search(parent: str, name: str) -> str:
    return ("/" if parent == "/" else parent.rstrip("/") + "/") + name


def _skip_walk(path: str) -> bool:
    return is_pseudo(path) or is_internal_runtime(path)


def estimate_paths(paths: list[str], limit: int = MAX_ESTIMATE_ENTRIES) -> tuple[int, int, int, bool]:
    total = 0
    files = 0
    dirs = 0
    seen = 0
    complete = True
    for path in paths:
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISLNK(st.st_mode) or stat.S_ISREG(st.st_mode):
            total += int(st.st_size)
            files += 1
            seen += 1
            if seen >= limit:
                complete = False
                break
            continue
        if stat.S_ISDIR(st.st_mode):
            # A selected directory is a filesystem boundary. Descend within its
            # filesystem, but do not silently pull in nested NFS/SMB/USB/bind
            # mounts merely because their mountpoints live below the selection.
            root_dev = st.st_dev
            for root, dirnames, filenames in os.walk(path, topdown=True, followlinks=False):
                dirs += 1
                seen += 1
                kept: list[str] = []
                for d in dirnames:
                    child = os.path.join(root, d)
                    if _skip_walk(child):
                        continue
                    try:
                        dst = os.lstat(child)
                    except OSError:
                        continue
                    if dst.st_dev != root_dev:
                        continue
                    kept.append(d)
                dirnames[:] = kept
                if seen >= limit:
                    complete = False
                    break
                for name in filenames:
                    p = os.path.join(root, name)
                    if _skip_walk(p):
                        continue
                    try:
                        fst = os.lstat(p)
                    except OSError:
                        continue
                    if fst.st_dev != root_dev:
                        continue
                    total += int(fst.st_size)
                    files += 1
                    seen += 1
                    if seen >= limit:
                        complete = False
                        break
                if not complete:
                    break
        if not complete:
            break
    return total, files, dirs, complete


def dedupe_sources(raw_paths: Any) -> list[str]:
    if not isinstance(raw_paths, list) or not raw_paths:
        raise ValueError("select at least one file or folder")
    if len(raw_paths) > 5000:
        raise ValueError("too many separately selected items")
    candidates = sorted({validate_source(p) for p in raw_paths}, key=lambda p: (p.count("/"), p))
    out: list[str] = []
    for path in candidates:
        if any(path == parent or under(path, parent) for parent in out):
            continue
        out.append(path)
    return out


def action_estimate(req: dict[str, Any]) -> dict[str, Any]:
    paths = dedupe_sources(req.get("paths"))
    total, files, dirs, complete = estimate_paths(paths)
    return {"bytes": total, "files": files, "directories": dirs, "complete": complete}


def _selection_file(paths: list[str], job_id: str) -> str:
    path = os.path.join(STAGING, f"{job_id}.selection")
    with open(path, "wb") as fh:
        for source in paths:
            member = source.lstrip("/").encode("utf-8", "surrogateescape")
            fh.write(member + b"\0")
    os.chmod(path, 0o600)
    return path


def _manifest_tree(job: dict[str, Any], estimate: dict[str, Any]) -> str:
    root = os.path.join(STAGING, f"{job['id']}.manifest")
    manifest_dir = os.path.join(root, ".linux-archive-explorer")
    os.makedirs(manifest_dir, mode=0o700, exist_ok=True)
    rel = os_release()
    manifest = {
        "schema": 1,
        "product": PRODUCT,
        "product_version": VERSION,
        "created_at": int(time.time()),
        "hostname": platform.node(),
        "os": rel.get("PRETTY_NAME", platform.system()),
        "os_id": rel.get("ID", ""),
        "os_version": rel.get("VERSION_ID", ""),
        "architecture": platform.machine(),
        "format": job["format"],
        "selected_paths": job["selected_paths"],
        "estimated_source_bytes": estimate.get("bytes", 0),
        "estimated_files": estimate.get("files", 0),
        "estimated_directories": estimate.get("directories", 0),
        "archive_semantics": {
            "numeric_owner": job["format"] != "zip",
            "acls": job["format"] != "zip",
            "xattrs": job["format"] != "zip",
            "sparse": job["format"] != "zip",
            "one_file_system": True,
            "symlinks_dereferenced": False,
            "zip_portability_mode": job["format"] == "zip",
        },
    }
    with open(os.path.join(manifest_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return root


def _tar_excludes() -> list[str]:
    args: list[str] = []
    for p in (STAGING, JOBS, UPLOADS, ROLLBACK, LOGS, RECOVERY):
        # Exclude relative member names because archive creation runs from /.
        args.extend(["--exclude", p.lstrip("/")])
        args.extend(["--exclude", p.lstrip("/") + "/*"])
    return args


def _zip_datetime(st: os.stat_result) -> tuple[int, int, int, int, int, int]:
    try:
        tm = time.localtime(st.st_mtime)
        year = min(2107, max(1980, tm.tm_year))
        return (year, tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
    except Exception:
        return (1980, 1, 1, 0, 0, 0)


def _zip_info(arcname: str, st: os.stat_result, directory: bool = False) -> zipfile.ZipInfo:
    name = arcname.rstrip("/") + "/" if directory else arcname
    info = zipfile.ZipInfo(name, date_time=_zip_datetime(st))
    info.create_system = 3
    info.external_attr = (st.st_mode & 0xFFFF) << 16
    if directory:
        info.external_attr |= 0x10
        info.compress_type = zipfile.ZIP_STORED
    else:
        info.compress_type = zipfile.ZIP_DEFLATED
    return info


def _zip_add_path(zf: zipfile.ZipFile, source: str, arcname: str, changed: list[str], skipped: list[str]) -> None:
    st_before = os.lstat(source)
    mode = st_before.st_mode
    if stat.S_ISDIR(mode) and not stat.S_ISLNK(mode):
        zf.writestr(_zip_info(arcname, st_before, True), b"")
        return
    if stat.S_ISLNK(mode):
        target = os.readlink(source).encode("utf-8", "surrogateescape")
        zf.writestr(_zip_info(arcname, st_before, False), target)
        return
    if stat.S_ISREG(mode):
        info = _zip_info(arcname, st_before, False)
        with open(source, "rb") as inf, zf.open(info, "w", force_zip64=True) as outf:
            shutil.copyfileobj(inf, outf, 1024 * 1024)
        try:
            st_after = os.lstat(source)
            if st_after.st_size != st_before.st_size or st_after.st_mtime_ns != st_before.st_mtime_ns:
                changed.append(source)
        except OSError:
            changed.append(source)
        return
    skipped.append(source)


def _create_zip(paths: list[str], output: str, manifest_root: str) -> tuple[list[str], list[str]]:
    changed: list[str] = []
    skipped: list[str] = []
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True, strict_timestamps=False) as zf:
        for source in paths:
            st = os.lstat(source)
            arc = source.lstrip("/")
            _zip_add_path(zf, source, arc, changed, skipped)
            if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
                continue
            root_dev = st.st_dev
            for root, dirnames, filenames in os.walk(source, topdown=True, followlinks=False):
                kept: list[str] = []
                for d in dirnames:
                    child = os.path.join(root, d)
                    if _skip_walk(child):
                        continue
                    try:
                        dst = os.lstat(child)
                    except OSError:
                        continue
                    if dst.st_dev != root_dev:
                        continue
                    _zip_add_path(zf, child, child.lstrip("/"), changed, skipped)
                    if stat.S_ISDIR(dst.st_mode) and not stat.S_ISLNK(dst.st_mode):
                        kept.append(d)
                dirnames[:] = kept
                for name in filenames:
                    child = os.path.join(root, name)
                    if _skip_walk(child):
                        continue
                    try:
                        fst = os.lstat(child)
                    except OSError:
                        continue
                    if fst.st_dev != root_dev:
                        continue
                    _zip_add_path(zf, child, child.lstrip("/"), changed, skipped)
        manifest_file = os.path.join(manifest_root, ".linux-archive-explorer", "manifest.json")
        st = os.lstat(manifest_file)
        _zip_add_path(zf, manifest_file, ".linux-archive-explorer/manifest.json", changed, skipped)
    return changed, skipped


def _verify_archive(path: str, fmt: str) -> None:
    if fmt == "zip":
        try:
            with zipfile.ZipFile(path, "r") as zf:
                bad = zf.testzip()
                if bad is not None:
                    raise RuntimeError(f"ZIP integrity check failed at {bad}")
        except zipfile.BadZipFile as exc:
            raise RuntimeError("ZIP archive verification failed") from exc
        return
    verify = subprocess.run(["/usr/bin/tar", "--list", "--file", path], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    if verify.returncode != 0:
        raise RuntimeError((verify.stderr or "archive verification failed").strip())


def _verify_restore_compatibility(job_id: str) -> None:
    """Fail archive creation if the Restore engine would reject its manifest or members."""
    proc = subprocess.run(
        ["/usr/bin/python3", str(HERE / "restore-helper.py")],
        input=json.dumps({"action": "validate-created-archive", "job_id": job_id}),
        capture_output=True, text=True, timeout=420,
    )
    try:
        report = json.loads(proc.stdout)
    except (ValueError, TypeError) as exc:
        raise RuntimeError("Restore compatibility verification did not return a valid result") from exc
    if proc.returncode or report.get("ok") is not True or not report.get("restore_compatible"):
        raise RuntimeError("Created archive failed Restore compatibility check: " + str(report.get("error", "verification failed")))


def action_queue_archive(req: dict[str, Any]) -> dict[str, Any]:
    ensure_runtime_dirs()
    paths = dedupe_sources(req.get("paths"))
    fmt = str(req.get("format", "tar.gz"))
    _, filename = safe_archive_name(req.get("archive_name", ""), fmt)
    destination = req.get("linux_destination")
    if destination is not None:
        destination = validate_destination(destination)
        final = os.path.join(destination, filename)
        if os.path.lexists(final):
            raise ValueError(f"an archive named {filename} already exists in that Linux folder")
    windows_requested = bool(req.get("windows_requested", False))
    if destination is None and not windows_requested:
        raise ValueError("choose Linux, Windows, or Both as the archive destination")
    total, files, dirs, complete = estimate_paths(paths)
    # Staging must have enough room for a pessimistic uncompressed result plus margin.
    free = disk_free(STAGING)
    required = min(total + 64 * 1024 * 1024, total * 2 + 64 * 1024 * 1024) if total else 64 * 1024 * 1024
    if required + immediate_size(STAGING) > TEMP_LIMIT_BYTES:
        raise ValueError("Archive would exceed the 256 MiB temporary staging limit. Choose a smaller archive selection.")
    require_space(STAGING, required, "archive staging")
    if free < required:
        raise ValueError(f"not enough free space in archive staging (need about {required} bytes, have {free})")
    job = new_job(
        "archive",
        filename=filename,
        format=fmt,
        selected_paths=paths,
        linux_destination=destination,
        windows_requested=windows_requested,
        estimate={"bytes": total, "files": files, "directories": dirs, "complete": complete},
    )
    _spawn_worker(str(job["id"]))
    audit("archive.queued", job_id=job["id"], filename=filename, selected_count=len(paths), linux_destination=destination, windows_requested=windows_requested)
    return {"job_id": job["id"], "filename": filename}


def _spawn_worker(job_id: str) -> None:
    subprocess.Popen(
        ["/usr/bin/python3", str(Path(__file__).resolve()), "--worker", job_id],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        close_fds=True, start_new_session=True, cwd="/",
        env={**os.environ, "PYTHONPATH": str(HERE)},
    )


def run_archive_job(job_id: str) -> None:
    ensure_runtime_dirs()
    job = load_job(job_id)
    if job.get("kind") != "archive":
        raise ValueError("not an archive job")
    selection = ""
    manifest_root = ""
    out = os.path.join(STAGING, f"{job_id}-{job['filename']}.part")
    final_stage = os.path.join(STAGING, f"{job_id}-{job['filename']}")
    try:
        set_job(job, "scanning", "Validating selected files and building archive manifest.")
        paths = dedupe_sources(job.get("selected_paths"))
        estimate = job.get("estimate") if isinstance(job.get("estimate"), dict) else {}
        selection = _selection_file(paths, job_id)
        manifest_root = _manifest_tree(job, estimate)
        set_job(job, "archiving", "Creating the archive. Files are read with their Linux ownership and permissions preserved.")
        fmt = str(job["format"])
        warning = None
        format_notice = None
        if fmt == "zip":
            changed, skipped = _create_zip(paths, out, manifest_root)
            notes = []
            if changed:
                notes.append(f"{len(changed)} file(s) changed while ZIP creation was running")
            if skipped:
                notes.append(f"{len(skipped)} special Linux file(s) were skipped because ZIP cannot represent them safely")
            warning = "; ".join(notes) if notes else None
            format_notice = "ZIP is intended for Windows portability. Linux ownership, ACLs, extended attributes and sparse-file metadata are not preserved as faithfully as tar formats."
        else:
            compression = FORMATS[fmt][1]
            # GNU tar --exclude options are POSITIONAL. They must precede
            # --files-from, otherwise selecting the application root also
            # archives its staging/manifest and turns the final manifest into
            # a hard link to that excluded copy. Restore then sees empty JSON.
            cmd = [
                "/usr/bin/tar", "--create", "--file", out, "--format=pax", "--acls", "--xattrs",
                "--numeric-owner", "--sparse", "--one-file-system", "--null", "--verbatim-files-from",
            ] + _tar_excludes() + ["-C", "/", "--files-from", selection] + compression + ["-C", manifest_root, ".linux-archive-explorer/manifest.json"]
            proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
            if proc.returncode == 1:
                warning = (proc.stderr or "Some files changed while the archive was being created.").strip()[-4000:]
            elif proc.returncode != 0:
                raise RuntimeError((proc.stderr or "GNU tar failed").strip())
        set_job(job, "verifying", "Verifying archive readability and calculating SHA-256.")
        _verify_archive(out, fmt)
        os.replace(out, final_stage)
        _verify_restore_compatibility(job_id)
        os.chown(final_stage, 0, WEB_GID)
        os.chmod(final_stage, 0o640)
        digest = sha256_file(final_stage)
        size = os.path.getsize(final_stage)
        linux_path = None
        destination = job.get("linux_destination")
        if destination:
            set_job(job, "copying", "Saving the verified archive to the selected Linux folder.")
            destination = validate_destination(destination)
            linux_path = os.path.join(destination, str(job["filename"]))
            if os.path.lexists(linux_path):
                raise RuntimeError("destination archive appeared while the job was running; refusing to overwrite it")
            require_space(destination, size, "permanent Linux archive copy")
            fsync_copy(final_stage, linux_path)
            if sha256_file(linux_path) != digest:
                try:
                    os.unlink(linux_path)
                except OSError:
                    pass
                raise RuntimeError("Linux destination copy failed SHA-256 verification")
        status = "warning" if warning else "completed"
        message = "Archive created and verified." if not warning else "Archive created and verified, but GNU tar reported a live-file warning."
        set_job(job, status, message, staged_path=final_stage, linux_path=linux_path, sha256=digest, size_bytes=size, warning=warning, format_notice=format_notice)
        # Linux-only jobs already have an independently hash-verified permanent
        # copy; there is no Windows download to serve. Release staging now.
        if linux_path and not job.get("windows_requested"):
            os.unlink(final_stage)
        audit("archive.completed", job_id=job_id, filename=job["filename"], sha256=digest, size_bytes=size, status=status, linux_path=linux_path)
    except Exception as exc:
        try:
            set_job(job, "failed", str(exc), error=str(exc))
        except Exception:
            pass
        audit("archive.failed", job_id=job_id, error=str(exc))
        app_error("archive.failed", job_id=job_id, error=str(exc))
        for p in (out, final_stage):
            try: os.unlink(p)
            except OSError: pass
    finally:
        if selection:
            try: os.unlink(selection)
            except OSError: pass
        if manifest_root:
            shutil.rmtree(manifest_root, ignore_errors=True)


def _job_archive_path(job: dict[str, Any]) -> str:
    path = str(job.get("staged_path") or "")
    real = os.path.realpath(path)
    if real and under(real, STAGING) and os.path.isfile(real):
        return real
    linux_path = str(job.get("linux_path") or "")
    if linux_path and os.path.isfile(linux_path) and not os.path.islink(linux_path):
        expected = str(job.get("sha256") or "")
        if expected and sha256_file(linux_path) == expected:
            return linux_path
    raise ValueError("archive is no longer available; download it again or use the saved Linux copy")


def action_list_archive(req: dict[str, Any]) -> dict[str, Any]:
    job_id = str(req.get("job_id", ""))
    job = load_job(job_id)
    if job.get("kind") != "archive" or job.get("status") not in ("completed", "warning"):
        raise ValueError("archive is not ready")
    path = _job_archive_path(job)
    limit = max(1, min(int(req.get("limit", 5000)), 20000))
    members, truncated = list_archive_members(path, limit=limit)
    return {"entries": members, "truncated": truncated}


def _users_path() -> str:
    return os.path.join(ROOT, "data", "users.json")


def _load_users_db() -> dict[str, Any]:
    path = _users_path()
    if not os.path.isfile(path):
        return {"schema": 1, "users": []}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError("user database is invalid") from exc
    if not isinstance(data, dict) or not isinstance(data.get("users"), list):
        raise ValueError("user database is invalid")
    return data


def _write_users_db(data: dict[str, Any]) -> None:
    path = _users_path()
    os.makedirs(os.path.dirname(path), mode=0o750, exist_ok=True)
    atomic_json(path, data, mode=0o640, gid=WEB_GID)


def _validate_username(username: str) -> str:
    username = username.strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", username):
        raise ValueError("invalid username")
    return username


def _validate_password_hash(password_hash: str) -> str:
    if not (password_hash.startswith("$argon2id$") or password_hash.startswith("$2y$") or password_hash.startswith("$2b$")):
        raise ValueError("unsupported password hash")
    return password_hash


def action_list_users(_: dict[str, Any]) -> dict[str, Any]:
    data = _load_users_db()
    users = []
    for user in data["users"]:
        if not isinstance(user, dict):
            continue
        users.append({
            "username": str(user.get("username", "")),
            "role": "admin" if str(user.get("role", "user")).lower() == "admin" else "user",
            "enabled": bool(user.get("enabled", True)),
            "created_at": int(user.get("created_at", 0) or 0),
        })
    users.sort(key=lambda u: u["username"].casefold())
    return {"users": users}


def action_upsert_user(req: dict[str, Any]) -> dict[str, Any]:
    username = _validate_username(str(req.get("username", "")))
    role = str(req.get("role", "user")).lower()
    if role not in {"admin", "user"}:
        raise ValueError("role must be admin or user")
    enabled = bool(req.get("enabled", True))
    password_hash = str(req.get("password_hash", "")).strip()
    if password_hash:
        _validate_password_hash(password_hash)
    data = _load_users_db()
    users = [u for u in data["users"] if isinstance(u, dict)]
    found = None
    for user in users:
        if str(user.get("username", "")) == username:
            found = user
            break
    if found is None:
        if not password_hash:
            raise ValueError("a password is required for a new user")
        found = {"username": username, "created_at": int(time.time())}
        users.append(found)
    found["role"] = role
    found["enabled"] = enabled
    if password_hash:
        found["password_hash"] = password_hash
    if not str(found.get("password_hash", "")):
        raise ValueError("user password hash is missing")
    active_admins = sum(1 for u in users if str(u.get("role", "user")).lower() == "admin" and bool(u.get("enabled", True)))
    if active_admins < 1:
        raise ValueError("at least one enabled administrator account is required")
    data["users"] = users
    _write_users_db(data)
    audit("auth.user_saved", username=username, role=role, enabled=enabled)
    return {"saved": True, "username": username}


def action_delete_user(req: dict[str, Any]) -> dict[str, Any]:
    username = _validate_username(str(req.get("username", "")))
    data = _load_users_db()
    users = [u for u in data["users"] if isinstance(u, dict)]
    target = next((u for u in users if str(u.get("username", "")) == username), None)
    if target is None:
        raise ValueError("user does not exist")
    remaining = [u for u in users if str(u.get("username", "")) != username]
    active_admins = sum(1 for u in remaining if str(u.get("role", "user")).lower() == "admin" and bool(u.get("enabled", True)))
    if active_admins < 1:
        raise ValueError("cannot delete the last enabled administrator account")
    data["users"] = remaining
    _write_users_db(data)
    audit("auth.user_deleted", username=username)
    return {"deleted": True}


def action_change_user_password(req: dict[str, Any]) -> dict[str, Any]:
    username = _validate_username(str(req.get("username", "")))
    password_hash = _validate_password_hash(str(req.get("password_hash", "")).strip())
    data = _load_users_db()
    for user in data["users"]:
        if isinstance(user, dict) and str(user.get("username", "")) == username:
            user["password_hash"] = password_hash
            _write_users_db(data)
            audit("auth.password_changed", username=username)
            return {"changed": True}
    raise ValueError("user does not exist")


def _replace_ini_value(raw: str, section: str, key: str, value: str) -> str:
    match = re.search(rf"(?ms)^\[{re.escape(section)}\]\s*\n(?P<body>.*?)(?=^\[|\Z)", raw)
    if not match:
        raise ValueError(f"configuration file is missing the [{section}] section")
    body = match.group("body")
    rendered = value
    if re.search(rf"(?m)^{re.escape(key)}\s*=", body):
        body = re.sub(rf"(?m)^{re.escape(key)}\s*=.*$", f"{key} = {rendered}", body, count=1)
    else:
        body += f"{key} = {rendered}\n"
    return raw[:match.start("body")] + body + raw[match.end("body"):]


def action_set_settings(req: dict[str, Any]) -> dict[str, Any]:
    timeout = int(req.get("session_timeout", 1800))
    if timeout not in {900, 1800, 3600, 7200}:
        raise ValueError("session timeout must be 15, 30, 60 or 120 minutes")
    fmt = str(req.get("default_format", "tar.gz"))
    if fmt not in FORMATS:
        raise ValueError("unsupported default archive format")
    path = config_path()
    raw = Path(path).read_text(encoding="utf-8")
    raw = _replace_ini_value(raw, "application", "session_timeout", str(timeout))
    raw = _replace_ini_value(raw, "application", "default_format", f'"{fmt}"')
    fd, tmp = tempfile.mkstemp(prefix=".config-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(raw); fh.flush(); os.fsync(fh.fileno())
        os.chown(tmp, 0, WEB_GID); os.chmod(tmp, 0o640); os.replace(tmp, path)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
    audit("settings.changed", session_timeout=timeout, default_format=fmt)
    return {"saved": True, "session_timeout": timeout, "default_format": fmt}


def _validate_manage_path(value: Any) -> str:
    path = validate_abs(value)
    if path == "/" or is_pseudo(path):
        raise ValueError("that path is protected from file-management operations")
    try:
        os.lstat(path)
    except FileNotFoundError as exc:
        raise ValueError("path no longer exists") from exc
    return path


def _archive_suffix(path: str) -> bool:
    return path.lower().endswith(KNOWN_SUFFIXES)


def action_properties(req: dict[str, Any]) -> dict[str, Any]:
    path = validate_abs(req.get("path"))
    if path == "/":
        raise ValueError("filesystem root properties are not available")
    try:
        st = os.lstat(path)
    except FileNotFoundError as exc:
        raise ValueError("path no longer exists") from exc
    user, group = owner_names(st)
    result = {
        "path": path,
        "name": os.path.basename(path),
        "is_dir": stat.S_ISDIR(st.st_mode),
        "is_symlink": stat.S_ISLNK(st.st_mode),
        "size": int(st.st_size),
        "modified": int(st.st_mtime),
        "mode": stat.filemode(st.st_mode),
        "mode_octal": oct(stat.S_IMODE(st.st_mode)),
        "owner": user,
        "group": group,
        "uid": int(st.st_uid),
        "gid": int(st.st_gid),
        "critical": any(under(path, p) or under(p, path) for p in ("/etc", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib64", ROOT)),
    }
    if stat.S_ISLNK(st.st_mode):
        try: result["link_target"] = os.readlink(path)
        except OSError: result["link_target"] = ""
    return result




# Administrator editor policy: regular UTF-8 text files are editable wherever
# the filesystem permits, including Linux Archive Explorer's live config.ini and
# application/runtime text. Virtual filesystems remain read-only. The editor's
# existing concurrency check, protected pre-edit backup, metadata preservation,
# atomic replace and typed SAVE confirmation on critical paths provide safety.




def _editor_requires_confirmation(path: str) -> bool:
    """Require typed SAVE only for the live LAE config and real system-critical paths.

    Ordinary LAE application/source text is still backed up and atomically replaced,
    but does not require repetitive typed confirmation.
    """
    norm = os.path.normpath(path)
    if norm == os.path.normpath(config_path()):
        return True
    if under(norm, ROOT):
        return False
    return is_critical(norm)

def _validate_editor_path(value: Any) -> tuple[str, os.stat_result]:
    path = validate_abs(value)
    if is_pseudo(path):
        raise ValueError("virtual system files under /proc, /sys, /dev and /run are read-only in the built-in editor")
    try:
        os.lstat(path)
    except FileNotFoundError as exc:
        raise ValueError("path no longer exists") from exc
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        raise ValueError("symbolic links are not editable in the built-in editor")
    if not stat.S_ISREG(st.st_mode):
        raise ValueError("only regular text files can be opened in the built-in editor")
    if st.st_size > MAX_EDITOR_BYTES:
        raise ValueError("text editor limit is 5 MiB")
    return path, st


def _decode_editor_bytes(raw: bytes) -> tuple[str, str, bool]:
    if b"\x00" in raw:
        raise ValueError("binary files cannot be opened in the text editor")
    bom = raw.startswith(b"\xef\xbb\xbf")
    payload = raw[3:] if bom else raw
    try:
        text = payload.decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise ValueError("this file is not UTF-8 text and cannot be safely edited in the browser") from exc
    crlf = payload.count(b"\r\n")
    lone_lf = payload.count(b"\n") - crlf
    line_ending = "crlf" if crlf > 0 and lone_lf == 0 else "lf"
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text, line_ending, bom


def action_read_text(req: dict[str, Any]) -> dict[str, Any]:
    path, st = _validate_editor_path(req.get("path"))
    try:
        raw = Path(path).read_bytes()
    except PermissionError as exc:
        raise ValueError("permission denied while reading text file") from exc
    if len(raw) > MAX_EDITOR_BYTES:
        raise ValueError("text editor limit is 5 MiB")
    text, line_ending, bom = _decode_editor_bytes(raw)
    user, group = owner_names(st)
    return {
        "path": path, "name": os.path.basename(path), "content": text,
        "sha256": sha256_file(path), "size_bytes": len(raw),
        "mode": stat.filemode(st.st_mode), "mode_octal": oct(stat.S_IMODE(st.st_mode)),
        "owner": user, "group": group, "uid": int(st.st_uid), "gid": int(st.st_gid),
        "line_ending": line_ending, "bom": bom, "hard_links": int(st.st_nlink),
        "critical": _editor_requires_confirmation(path),
    }


def _editor_backup(path: str) -> str:
    edits_root = os.path.join(ROLLBACK, "edits")
    os.makedirs(edits_root, mode=0o700, exist_ok=True)
    os.chown(edits_root, 0, 0); os.chmod(edits_root, 0o700)
    bundle = os.path.join(edits_root, f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:12]}")
    os.makedirs(bundle, mode=0o700, exist_ok=False)
    os.chown(bundle, 0, 0); os.chmod(bundle, 0o700)
    backup = os.path.join(bundle, os.path.basename(path))
    proc = subprocess.run(["/usr/bin/cp", "-a", "--reflink=auto", "--", path, backup], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    if proc.returncode != 0:
        shutil.rmtree(bundle, ignore_errors=True)
        raise RuntimeError((proc.stderr or "unable to create pre-edit safety copy").strip())
    meta = {"source_path": path, "backup_path": backup, "created_at": int(time.time()), "sha256": sha256_file(backup)}
    meta_path = os.path.join(bundle, "metadata.json")
    Path(meta_path).write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chown(meta_path, 0, 0); os.chmod(meta_path, 0o600)
    return backup


def action_write_text(req: dict[str, Any]) -> dict[str, Any]:
    path, st = _validate_editor_path(req.get("path"))
    if st.st_nlink != 1:
        raise ValueError("files with multiple hard links are not edited because atomic replacement would break the hard-link relationship")
    expected = str(req.get("expected_sha256", "")).lower().strip()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("original file checksum is required")
    current = sha256_file(path)
    if current != expected:
        raise ValueError("file changed on disk after it was opened; reload it before saving")
    critical = _editor_requires_confirmation(path)
    if critical and str(req.get("confirmation_text", "")) != "SAVE":
        raise ValueError("editing a critical system path requires typing SAVE")
    content = req.get("content")
    if not isinstance(content, str):
        raise ValueError("text content is required")
    if "\x00" in content:
        raise ValueError("binary content cannot be saved in the text editor")
    # Never replace the live configuration with syntactically invalid INI.
    # config.ini.example is ordinary documentation/sample text and is not
    # validated as the live configuration.
    if os.path.normpath(path) == os.path.normpath(config_path()):
        probe = configparser.ConfigParser(interpolation=None)
        try:
            probe.read_string(content)
        except configparser.Error as exc:
            raise ValueError(f"config.ini is not valid INI; nothing was saved: {exc}") from exc
    line_ending = str(req.get("line_ending", "lf"))
    bom = bool(req.get("bom", False))
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if line_ending == "crlf":
        normalized = normalized.replace("\n", "\r\n")
    payload = normalized.encode("utf-8")
    if bom:
        payload = b"\xef\xbb\xbf" + payload
    if len(payload) > MAX_EDITOR_BYTES:
        raise ValueError("text editor limit is 5 MiB")
    # Refuse edits that would consume the minimum filesystem safety reserve.
    require_space(ROLLBACK, os.path.getsize(path) + len(payload) + 1024 * 1024, "pre-edit safety backup")
    if os.path.getsize(path) > EDITS_LIMIT_BYTES:
        raise ValueError("This file exceeds the protected editor-backup storage limit")
    backup = _editor_backup(path)
    directory = os.path.dirname(path) or "/"
    fd, tmp = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.lae-edit-", dir=directory)
    os.close(fd)
    try:
        proc = subprocess.run(["/usr/bin/cp", "-a", "--reflink=auto", "--", path, tmp], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or "unable to stage edited file").strip())
        with open(tmp, "wb") as fh:
            fh.write(payload); fh.flush(); os.fsync(fh.fileno())
        if sha256_file(path) != expected:
            raise ValueError("file changed on disk while the save was being prepared; no changes were applied")
        os.replace(tmp, path)
        dfd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try: os.fsync(dfd)
        finally: os.close(dfd)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
    digest = sha256_file(path)
    try:
        prune_safety_bundles(ROLLBACK)
    except Exception as exc:
        app_error("cleanup.post_edit_failed", error=str(exc))
    audit("file.edited", path=path, backup=backup, sha256=digest, critical=critical)
    return {"saved": True, "path": path, "sha256": digest, "backup_path": backup, "critical": critical}

def action_archive_file(req: dict[str, Any]) -> dict[str, Any]:
    path = _validate_manage_path(req.get("path"))
    if not os.path.isfile(path) or not _archive_suffix(path):
        raise ValueError("choose a supported archive file")
    mode = str(req.get("mode", "info"))
    digest = sha256_file(path)
    members, truncated = list_archive_members(path, limit=max(1, min(int(req.get("limit", 10000)), 20000)))
    manifest = None
    try: manifest = extract_manifest(path)
    except Exception: manifest = None
    if mode == "verify":
        if path.lower().endswith(".zip"):
            try:
                with zipfile.ZipFile(path, "r") as zf:
                    bad = zf.testzip()
                    if bad is not None: raise ValueError(f"ZIP CRC verification failed at {bad}")
            except zipfile.BadZipFile as exc:
                raise ValueError("ZIP archive is invalid") from exc
        else:
            proc = subprocess.run(["/usr/bin/tar", "--list", "--file", path], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
            if proc.returncode != 0: raise ValueError((proc.stderr or "archive verification failed").strip())
        audit("archive.verified", path=path, sha256=digest)
    return {
        "path": path, "name": os.path.basename(path), "size_bytes": os.path.getsize(path),
        "sha256": digest, "entries": members if mode in {"list", "verify", "info"} else [],
        "truncated": truncated, "manifest": manifest,
        "format": "zip" if path.lower().endswith(".zip") else "tar",
        "verified": mode == "verify",
    }


def action_stage_download(req: dict[str, Any]) -> dict[str, Any]:
    path = _validate_manage_path(req.get("path"))
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError("direct Windows transfer currently requires a regular file; use Create Archive for folders")
    job = new_job("download", filename=os.path.basename(path), source_path=path)
    staged = os.path.join(STAGING, f"{job['id']}-{os.path.basename(path)}")
    fsync_copy(path, staged)
    os.chown(staged, 0, WEB_GID); os.chmod(staged, 0o640)
    digest = sha256_file(staged)
    set_job(job, "completed", "File prepared for transfer.", staged_path=staged, sha256=digest, size_bytes=os.path.getsize(staged))
    audit("transfer.download_staged", job_id=job["id"], source=path, size_bytes=os.path.getsize(staged))
    return {"job_id": job["id"], "filename": os.path.basename(path), "sha256": digest, "size_bytes": os.path.getsize(staged)}


def _safe_relative_path(value: Any) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or value.startswith(("/", "\\")):
        raise ValueError("invalid relative transfer path")
    value = value.replace("\\", "/")
    parts = [p for p in value.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise ValueError("unsafe relative transfer path")
    if any(any(ord(ch) < 32 for ch in p) for p in parts):
        raise ValueError("transfer path contains control characters")
    return "/".join(parts)


def validate_transfer_destination(path: Any) -> str:
    destination = validate_destination(path)
    if is_internal_runtime(destination):
        raise ValueError("Linux Archive Explorer runtime directories cannot be used as transfer destinations")
    return destination


def action_transfer_destination_info(req: dict[str, Any]) -> dict[str, Any]:
    destination = validate_transfer_destination(req.get("path"))
    return {"path": destination, "critical": is_critical(destination)}


def _transfer_target(destination: str, relative_path: Any) -> str:
    rel = _safe_relative_path(relative_path)
    target = os.path.normpath(os.path.join(destination, rel))
    if not under(target, destination):
        raise ValueError('transfer target escaped selected Linux folder')
    # The browser may write into newly created nested folders, but it must never
    # use a symlink to escape the selected root (including an existing symlink).
    parent = os.path.realpath(os.path.dirname(target))
    if not under(parent, os.path.realpath(destination)):
        raise ValueError('transfer target traverses a symlink outside the destination')
    if is_internal_runtime(parent):
        raise ValueError('transfer cannot write into application runtime storage')
    return target


def _keep_both_name(target: str) -> str:
    folder, filename = os.path.split(target)
    stem, suffix = os.path.splitext(filename)
    if not stem: stem, suffix = filename, ''
    for idx in range(2, 1002):
        candidate = os.path.join(folder, f'{stem} ({idx}){suffix}')
        if not os.path.lexists(candidate):
            return candidate
    raise ValueError('Unable to find a free name for Keep Both')


def action_transfer_target_info(req: dict[str, Any]) -> dict[str, Any]:
    destination = validate_transfer_destination(req.get('destination'))
    target = _transfer_target(destination, req.get('relative_path'))
    exists = os.path.lexists(target)
    return {'path': target, 'exists': exists,
            'is_directory': bool(exists and os.path.isdir(target) and not os.path.islink(target)),
            'is_regular_file': bool(exists and os.path.isfile(target) and not os.path.islink(target)),
            'keep_both_path': _keep_both_name(target) if exists else target}


def action_import_upload(req: dict[str, Any]) -> dict[str, Any]:
    upload = validate_abs(req.get('upload_path'))
    real_upload = os.path.realpath(upload)
    if not under(real_upload, UPLOADS) or not os.path.isfile(real_upload):
        raise ValueError('transfer upload is not in protected staging')
    destination = validate_transfer_destination(req.get('destination'))
    target = _transfer_target(destination, req.get('relative_path'))
    decision = str(req.get('conflict_action', 'error'))
    if decision not in {'error', 'replace', 'keep-both'}:
        raise ValueError('unsupported transfer conflict choice')
    if (is_critical(target) or is_critical(os.path.realpath(os.path.dirname(target)))) and str(req.get('confirmation_text', '')) != 'TRANSFER':
        raise ValueError('Windows-to-Linux transfer into a critical path requires typing TRANSFER')
    exists = os.path.lexists(target)
    if exists:
        if decision == 'keep-both':
            target = _keep_both_name(target)
        elif decision == 'replace':
            if not os.path.isfile(target) or os.path.islink(target):
                raise ValueError('Replace is available only for an existing regular file; use Merge for folders')
        else:
            raise ValueError(f'a file or folder already exists at {target}; choose how to handle the conflict')
    require_space(destination, os.path.getsize(real_upload), 'transfer into Linux')
    os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
    # fsync_copy uses a same-directory temporary file and atomic rename; stage
    # the new bytes separately so an interrupted write never truncates a target.
    staged = os.path.join(os.path.dirname(target), f'.lae-upload-{uuid.uuid4().hex}.part')
    moved_old = None
    try:
        fsync_copy(real_upload, staged, mode=0o640)
        if exists and decision == 'replace':
            moved_old = action_trash_path({'path': target, 'confirmation_text': 'DELETE'})
        elif os.path.lexists(target):
            raise ValueError('destination changed during transfer; no files overwritten')
        # Only Replace may use os.replace over an existing path; unexpected
        # races on normal/Keep Both paths are rejected with an exclusive link.
        if moved_old:
            os.replace(staged, target)
        else:
            os.link(staged, target, follow_symlinks=False)
            os.unlink(staged)
    except Exception:
        if moved_old and not os.path.lexists(target):
            try: os.rename(moved_old['trash_path'], target)
            except OSError as exc: app_error('transfer.replace_rollback_failed', path=target, error=str(exc))
        raise
    finally:
        try: os.unlink(staged)
        except FileNotFoundError: pass
    try: os.unlink(real_upload)
    except OSError: pass
    audit('transfer.upload_completed', destination=target, size_bytes=os.path.getsize(target), conflict_action=decision)
    return {'path': target, 'size_bytes': os.path.getsize(target), 'replaced': bool(moved_old), 'renamed': decision == 'keep-both' and exists}


def action_walk_dir(req: dict[str, Any]) -> dict[str, Any]:
    path = _validate_manage_path(req.get("path"))
    if not os.path.isdir(path) or os.path.islink(path):
        raise ValueError("walk source must be a real directory")
    limit = max(1, min(int(req.get("limit", 20000)), 50000))
    root_dev = os.lstat(path).st_dev
    entries: list[dict[str, Any]] = []
    for root, dirnames, filenames in os.walk(path, topdown=True, followlinks=False):
        kept=[]
        for name in dirnames:
            child=os.path.join(root,name)
            if _skip_walk(child): continue
            try: st=os.lstat(child)
            except OSError: continue
            if st.st_dev != root_dev: continue
            rel=os.path.relpath(child,path).replace(os.sep,"/")
            entries.append({"path":child,"relative":rel,"is_dir":True,"is_symlink":stat.S_ISLNK(st.st_mode),"size":0})
            if len(entries)>=limit: return {"entries":entries,"truncated":True}
            if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode): kept.append(name)
        dirnames[:]=kept
        for name in filenames:
            child=os.path.join(root,name)
            if _skip_walk(child): continue
            try: st=os.lstat(child)
            except OSError: continue
            if st.st_dev != root_dev: continue
            rel=os.path.relpath(child,path).replace(os.sep,"/")
            entries.append({"path":child,"relative":rel,"is_dir":False,"is_symlink":stat.S_ISLNK(st.st_mode),"size":int(st.st_size)})
            if len(entries)>=limit: return {"entries":entries,"truncated":True}
    return {"entries":entries,"truncated":False}


def action_queue_file_op(req: dict[str, Any]) -> dict[str, Any]:
    op = str(req.get('op', ''))
    if op not in {'copy', 'move'}:
        raise ValueError('unsupported file operation')
    sources_raw = req.get('sources')
    if not isinstance(sources_raw, list) or not sources_raw or len(sources_raw) > 200:
        raise ValueError('choose between 1 and 200 source items')
    sources = [_validate_manage_path(p) for p in sources_raw]
    destination = validate_destination(req.get('destination'))
    destination_critical = is_critical(destination)
    source_critical = any(is_critical(p) for p in sources)
    required_confirmation = ''
    if op == 'copy' and destination_critical: required_confirmation = 'COPY'
    if op == 'move' and (destination_critical or source_critical): required_confirmation = 'MOVE'
    if required_confirmation and str(req.get('confirmation_text', '')) != required_confirmation:
        raise ValueError(f'critical {op} requires typing {required_confirmation}')
    decision = str(req.get('conflict_action', 'error'))
    if decision not in {'error', 'replace', 'keep-both', 'merge'}:
        raise ValueError('unsupported conflict choice')
    if len(sources) > 1 and decision != 'error':
        raise ValueError('resolve multiple file conflicts individually')
    targets=[]
    for src in sources:
        if os.path.isdir(src) and not os.path.islink(src) and under(destination, src):
            raise ValueError('cannot copy or move a directory into itself')
        target = os.path.join(destination, os.path.basename(src))
        exists=os.path.lexists(target)
        if exists:
            if decision == 'keep-both':
                target=_keep_both_name(target)
            elif decision == 'replace':
                if not os.path.isfile(target) or os.path.islink(target) or os.path.isdir(src):
                    raise ValueError('Replace is supported only for regular files')
            elif decision == 'merge':
                if op != 'copy' or not os.path.isdir(src) or os.path.islink(src) or not os.path.isdir(target) or os.path.islink(target):
                    raise ValueError('Merge is supported only for Copy of folders')
            else:
                raise ValueError(f'destination already contains {os.path.basename(src)}; choose an option')
        targets.append(target)
    if op == 'copy' or any(os.lstat(x).st_dev != os.lstat(destination).st_dev for x in sources):
        required = sum(content_size(src) for src in sources)
        require_space(destination, required, f'Linux {op}')
    job = new_job('file-op', op=op, sources=sources, destination=destination,
                  targets=targets, conflict_action=decision)
    subprocess.Popen(
        ['/usr/bin/python3', str(Path(__file__).resolve()), '--file-worker', str(job['id'])],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        close_fds=True, start_new_session=True, cwd='/', env={**os.environ, 'PYTHONPATH': str(HERE)},
    )
    audit(f'file.{op}_queued', job_id=job['id'], count=len(sources), destination=destination, conflict_action=decision)
    return {'job_id': job['id'], 'target_paths': targets}


def run_file_op_job(job_id: str) -> None:
    job = load_job(job_id)
    if job.get('kind') != 'file-op': raise ValueError('not a file operation job')
    op = str(job.get('op'))
    sources = [_validate_manage_path(p) for p in job.get('sources', [])]
    destination = validate_destination(job.get('destination'))
    targets=job.get('targets') or [os.path.join(destination,os.path.basename(s)) for s in sources]
    decision=str(job.get('conflict_action','error'))
    moved_old=None
    try:
        set_job(job, 'copying' if op == 'copy' else 'moving', f'{op.title()}ing selected item(s).')
        for source,target in zip(sources,targets):
            if not under(target,destination) or os.path.islink(os.path.dirname(target)):
                raise ValueError('operation target changed or escaped the Linux folder')
            if os.path.lexists(target):
                if decision == 'replace' and os.path.isfile(target) and not os.path.islink(target):
                    moved_old = action_trash_path({'path':target,'confirmation_text':'DELETE'})
                elif (decision == 'merge' and op == 'copy' and os.path.isdir(source) and not os.path.islink(source) and os.path.isdir(target) and not os.path.islink(target)):
                    # --no-clobber copies missing children, never overwrites an
                    # existing member. Existing destination folder is explicit.
                    proc=subprocess.run(['/usr/bin/cp','-an','--',source+'/.',target+'/'],
                                        stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,errors='replace')
                    if proc.returncode:raise RuntimeError((proc.stderr or 'merge failed').strip())
                    continue
                else:raise ValueError('destination appeared or changed while the file operation was running')
            args=['/usr/bin/cp','-a','--',source,target] if op=='copy' else ['/usr/bin/mv','--',source,target]
            proc=subprocess.run(args,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,errors='replace')
            if proc.returncode:raise RuntimeError((proc.stderr or f'{op} failed').strip())
        set_job(job,'completed',f'{op.title()} completed.',target_paths=targets)
        audit(f'file.{op}_completed',job_id=job_id,count=len(sources),destination=destination)
    except Exception as exc:
        if moved_old:
            # Recover previous destination if replacement failed and it is absent.
            target=targets[-1]
            if not os.path.lexists(target):
                try:os.rename(moved_old['trash_path'],target)
                except OSError as recovery:app_error('file.replace_recovery_failed',path=target,error=str(recovery))
        set_job(job,'failed',str(exc),error=str(exc))
        audit(f'file.{op}_failed',job_id=job_id,error=str(exc))
        app_error(f'file.{op}_failed',job_id=job_id,error=str(exc))


def action_make_directory(req: dict[str, Any]) -> dict[str, Any]:
    destination = validate_destination(req.get("destination"))
    # Apply the same symlink/containment guard as file uploads, including
    # nested folder creation during Windows-to-Linux transfers.
    target = _transfer_target(destination, req.get("relative_path"))
    if (is_critical(destination) or is_critical(target)) and str(req.get("confirmation_text", "")) not in {"CREATE", "TRANSFER"}:
        raise ValueError("creating a directory in a critical path requires typing CREATE")
    if os.path.lexists(target):
        if os.path.isdir(target) and not os.path.islink(target):
            return {"path": target, "created": False}
        raise ValueError(f"a file or folder already exists at {target}")
    os.makedirs(target, mode=0o755, exist_ok=False)
    audit("file.directory_created", path=target)
    return {"path": target, "created": True}


def action_make_file(req: dict[str, Any]) -> dict[str, Any]:
    destination = validate_destination(req.get('destination'))
    name = str(req.get('name', '')).strip()
    if (not name or name in {'.', '..'} or name.startswith('.') and name in {'..'}
        or '/' in name or '\\' in name or any(ord(c) < 32 for c in name)
        or len(name.encode('utf-8')) > 255):
        raise ValueError('invalid new file name')
    target = os.path.join(os.path.realpath(destination), name)
    if (is_critical(destination) or is_critical(target)) and str(req.get('confirmation_text', '')) != 'CREATE':
        raise ValueError('creating a file in a critical path requires typing CREATE')
    if os.path.lexists(target):
        raise ValueError('a file or folder with that name already exists')
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o644)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    audit('file.created', path=target)
    return {'path': target, 'created': True}


def action_rename_path(req: dict[str, Any]) -> dict[str, Any]:
    path = _validate_manage_path(req.get("path"))
    if is_critical(path) and str(req.get("confirmation_text", "")) != "RENAME":
        raise ValueError("renaming a critical path requires typing RENAME")
    name = str(req.get("new_name", "")).strip()
    if not name or name in {".", ".."} or "/" in name or "\\" in name or any(ord(c)<32 for c in name):
        raise ValueError("invalid new name")
    target = os.path.join(os.path.dirname(path), name)
    if os.path.lexists(target): raise ValueError("an item with that name already exists")
    os.rename(path, target)
    audit("file.renamed", source=path, destination=target)
    return {"path": target}


def _safe_xattrs(path: str) -> dict[str, bytes]:
    try:
        names = os.listxattr(path, follow_symlinks=False)
    except (AttributeError, OSError):
        return {}
    result: dict[str, bytes] = {}
    for name in names:
        try:
            result[name] = os.getxattr(path, name, follow_symlinks=False)
        except OSError:
            pass
    return result


def _tree_inventory(root: str) -> tuple[dict[str, dict[str, Any]], list[list[str]]]:
    entries: dict[str, dict[str, Any]] = {}
    hardlinks: dict[tuple[int, int], list[str]] = {}

    def add(path: str, rel: str) -> None:
        st = os.lstat(path)
        kind = stat.S_IFMT(st.st_mode)
        info: dict[str, Any] = {
            "kind": kind, "mode": stat.S_IMODE(st.st_mode), "uid": st.st_uid, "gid": st.st_gid,
            "mtime_ns": st.st_mtime_ns, "xattrs": _safe_xattrs(path),
        }
        if stat.S_ISREG(st.st_mode):
            info["size"] = st.st_size
            info["sha256"] = sha256_file(path)
            if st.st_nlink > 1:
                hardlinks.setdefault((st.st_dev, st.st_ino), []).append(rel)
        elif stat.S_ISLNK(st.st_mode):
            info["link_target"] = os.readlink(path)
        elif stat.S_ISCHR(st.st_mode) or stat.S_ISBLK(st.st_mode):
            info["rdev"] = st.st_rdev
        elif stat.S_ISSOCK(st.st_mode):
            raise ValueError("socket files cannot be safely moved to protected trash")
        entries[rel] = info

    add(root, ".")
    if os.path.isdir(root) and not os.path.islink(root):
        for base, dirs, files in os.walk(root, topdown=True, followlinks=False):
            dirs.sort(); files.sort()
            for name in dirs + files:
                child = os.path.join(base, name)
                rel = os.path.relpath(child, root).replace(os.sep, "/")
                add(child, rel)
    groups = sorted(sorted(v) for v in hardlinks.values() if len(v) > 1)
    return entries, groups


def _verify_protected_copy(source: str, backup: str) -> None:
    before, before_links = _tree_inventory(source)
    after, after_links = _tree_inventory(backup)
    if before != after or before_links != after_links:
        raise RuntimeError("protected delete safety copy failed verification; original was not removed")


def _copy_to_protected_trash(source: str, target: str) -> None:
    proc = subprocess.run(
        ["/usr/bin/cp", "-a", "--reflink=auto", "--", source, target],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "unable to create protected delete safety copy").strip())
    subprocess.run(["/usr/bin/sync", "-f", target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _verify_protected_copy(source, target)


def _remove_after_verified_backup(path: str) -> None:
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def action_trash_path(req: dict[str, Any]) -> dict[str, Any]:
    path = _validate_manage_path(req.get("path"))
    if os.path.ismount(path):
        raise ValueError("mounted filesystems cannot be deleted from Linux Archive Explorer")
    critical = is_critical(path)
    if critical and str(req.get("confirmation_text", "")) != "DELETE":
        raise ValueError("critical path deletion requires typing DELETE")
    # A large Delete is refused rather than secretly retaining unlimited trash
    # or changing a protected Delete into irreversible removal.
    size = content_size(path, TRASH_LIMIT_BYTES)
    if size > TRASH_LIMIT_BYTES:
        raise ValueError("This item exceeds the 64 MiB protected Delete limit. No files were removed; use a smaller selection or a separate administrator operation.")
    require_space(ROLLBACK, size if os.lstat(path).st_dev != os.lstat(ROLLBACK).st_dev else 0, "protected Delete")
    trash_root = os.path.join(ROLLBACK, "trash")
    os.makedirs(trash_root, mode=0o700, exist_ok=True)
    bundle = os.path.join(trash_root, f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:12]}")
    os.makedirs(bundle, mode=0o700)
    target = os.path.join(bundle, os.path.basename(path))
    same_filesystem = os.lstat(path).st_dev == os.lstat(trash_root).st_dev
    meta = {
        "source_path": path, "trash_path": target, "prepared_at": int(time.time()),
        "critical": critical, "method": "rename" if same_filesystem else "verified-copy-delete",
        "state": "prepared",
    }
    meta_path = os.path.join(bundle, "metadata.json")
    atomic_json(meta_path, meta, mode=0o600, gid=0)
    try:
        if same_filesystem:
            os.rename(path, target)
        else:
            _copy_to_protected_trash(path, target)
            _remove_after_verified_backup(path)
        meta["state"] = "trashed"
        meta["deleted_at"] = int(time.time())
        atomic_json(meta_path, meta, mode=0o600, gid=0)
    except Exception:
        # If the original still exists, never remove the safety material; it can be
        # inspected during recovery. If the original was removed, target is the rollback copy.
        raise
    # Keep one short-lived protected trash entry. Never prune the newly
    # prepared entry in an interrupted operation (state must be 'trashed').
    try:
        prune_safety_bundles(ROLLBACK)
    except Exception as exc:
        app_error("cleanup.post_delete_failed", error=str(exc))
    audit("file.trashed", source=path, trash_path=target, critical=critical, method=meta["method"])
    return {"deleted": True, "trash_path": target, "critical": critical, "method": meta["method"]}


def action_log_event(req: dict[str, Any]) -> dict[str, Any]:
    event = str(req.get("event", ""))[:120]
    allowed = {
        "auth.login_success", "auth.login_failure", "auth.logout", "auth.password_changed",
        "auth.user_saved", "auth.user_deleted", "settings.changed", "archive.verify_requested",
        "security.csrf_failure", "security.verify", "ui.help_opened",
    }
    if event not in allowed:
        raise ValueError("event is not permitted")
    details = req.get("details") if isinstance(req.get("details"), dict) else {}
    scrubbed: dict[str, Any] = {}
    for k, v in details.items():
        if k.lower() in {"password", "token", "cookie", "session", "password_hash"}:
            continue
        if isinstance(v, (str, int, float, bool)) or v is None:
            scrubbed[str(k)[:80]] = v if not isinstance(v, str) else v[:500]
    write_log("audit.log", event, scrubbed, mode=0o640, gid=0)
    return {"logged": True}


def action_system_info(_: dict[str, Any]) -> dict[str, Any]:
    return public_system_info()


def action_storage_report(_: dict[str, Any]) -> dict[str, Any]:
    from storage_policy import storage_report
    return {"storage": storage_report(ROOT)}


def action_storage_reset(req: dict[str, Any]) -> dict[str, Any]:
    if req.get("confirmation") != "RESET":
        raise ValueError("Type RESET exactly to authorize storage cleanup")
    proc = subprocess.run(["/usr/bin/python3", str(HERE / "storage-maintenance.py"), "--reset"],
                          capture_output=True, text=True, timeout=240)
    if proc.returncode != 0:
        raise ValueError("Storage cleanup was refused: " + (proc.stderr or proc.stdout).strip()[-500:])
    result = json.loads(proc.stdout)
    audit("storage.reset", removed_installer=result.get("cleanup", {}).get("installer", {}).get("removed", 0))
    return {"storage": result.get("after", {}), "cleanup_completed": True}


def action_storage_clear(req: dict[str, Any]) -> dict[str, Any]:
    scope = str(req.get('scope', ''))
    permitted = {'staging', 'uploads', 'jobs', 'trash', 'edits', 'restore', 'ui', 'installer'}
    if scope not in permitted or req.get('confirmation') != 'CLEAR ' + scope.upper():
        raise ValueError('Invalid storage area or confirmation')
    proc = subprocess.run(['/usr/bin/python3', str(HERE / 'storage-maintenance.py'), '--clear-scope', scope],
                          capture_output=True, text=True, timeout=240)
    if proc.returncode != 0:
        raise ValueError('Storage cleanup was refused: ' + (proc.stderr or proc.stdout).strip()[-500:])
    result = json.loads(proc.stdout)
    audit('storage.clear', area=scope)
    return {'storage': result.get('after', {}), 'cleanup_completed': True}


def action_complete_download(req: dict[str, Any]) -> dict[str, Any]:
    """Release one verified staged archive only after HTTP fully streams it.

    The browser may still decline writing the bytes. This action does not
    certify a file on the user's computer; it only releases server staging.
    HTTP range requests retain staging to permit resume. Permanent Linux
    copies and protected Restore snapshots are never touched.
    """
    job_id = str(req.get("job_id", ""))
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise ValueError("invalid download job")
    job = load_job(job_id)
    if job.get("kind") not in ("archive", "download") or job.get("status") not in ("completed", "warning"):
        raise ValueError("download job is not complete")
    staged = str(job.get("staged_path") or "")
    expected_prefix = os.path.join(STAGING, job_id + "-")
    if not staged.startswith(expected_prefix) or os.path.dirname(staged) != STAGING:
        raise ValueError("staging path is invalid")
    if os.path.islink(staged):
        raise ValueError("staging symlink refused")
    try:
        os.unlink(staged)
    except FileNotFoundError:
        pass
    audit("archive.staging_released", job_id=job_id)
    return {"released": True}


def action_cleanup(_: dict[str, Any]) -> dict[str, Any]:
    """Automatic housekeeping, with active-job and protected-recovery safeguards."""
    ensure_runtime_dirs()
    if os.path.lexists(os.path.join(JOBS, 'restore.lock')):
        return {'deferred': True, 'reason': 'restore lock present'}
    proc = subprocess.run(['/usr/bin/python3', str(HERE / 'storage-maintenance.py'), '--auto'],
                          capture_output=True, text=True, timeout=240)
    if proc.returncode != 0:
        app_error('cleanup.failed', error=(proc.stderr or proc.stdout)[-500:])
        raise ValueError('Scheduled storage cleanup failed; protected data left unchanged')
    result = json.loads(proc.stdout)
    # Restore History is pruned by its own privileged helper, which recognizes
    # protected and incomplete snapshots. It is never deleted by file age alone.
    helper = str(HERE / 'restore-helper.py')
    restore = subprocess.run(['/usr/bin/python3', helper, '--prune'],
                             capture_output=True, text=True, timeout=180)
    if restore.returncode != 0:
        app_error('cleanup.restore_history_failed', error=(restore.stderr or restore.stdout)[-500:])
        raise ValueError('Restore History cleanup failed; protected data left unchanged')
    cleanup = result.get('cleanup', {})
    removed = sum(int(section.get('removed', 0)) for section in cleanup.values() if isinstance(section, dict))
    return {'removed': removed, 'cleanup': cleanup, 'restore': json.loads(restore.stdout)}


ACTIONS = {
    "list-dir": action_list_dir,
    "search-dir": action_search_dir,
    "estimate": action_estimate,
    "queue-archive": action_queue_archive,
    "list-archive": action_list_archive,
    "properties": action_properties,
    "read-text": action_read_text,
    "write-text": action_write_text,
    "archive-file": action_archive_file,
    "stage-download": action_stage_download,
    "transfer-destination-info": action_transfer_destination_info,
    "import-upload": action_import_upload,
    "transfer-target-info": action_transfer_target_info,
    "walk-dir": action_walk_dir,
    "make-directory": action_make_directory,
    "make-file": action_make_file,
    "queue-file-op": action_queue_file_op,
    "rename-path": action_rename_path,
    "trash-path": action_trash_path,
    "list-users": action_list_users,
    "upsert-user": action_upsert_user,
    "delete-user": action_delete_user,
    "change-user-password": action_change_user_password,
    "set-settings": action_set_settings,
    "log-event": action_log_event,
    "system-info": action_system_info,
    "cleanup": action_cleanup,
    "complete-download": action_complete_download,
    "storage-report": action_storage_report,
    "storage-reset": action_storage_reset,
    "storage-clear": action_storage_clear,
}


def web_main() -> None:
    ensure_runtime_dirs()
    req = read_request()
    action = str(req.pop("action", ""))
    if action not in ACTIONS:
        raise ValueError("unsupported archive helper action")
    if CONFIG_LOAD_ERROR and action not in {"list-dir", "search-dir", "properties", "read-text", "write-text"}:
        raise ValueError("Linux Archive Explorer config.ini is invalid. Administrator recovery browsing and the text editor remain available; repair config.ini before other operations. " + CONFIG_LOAD_ERROR)
    result = ACTIONS[action](req)
    emit({"ok": True, **result})


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--cleanup":
        if os.geteuid() != 0 and os.environ.get("LAE_DEV") != "1":
            raise SystemExit("cleanup service requires root")
        result = action_cleanup({})
        print(json.dumps(result))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--file-worker":
        if os.geteuid() != 0 and os.environ.get("LAE_DEV") != "1":
            raise SystemExit("file worker requires root")
        run_file_op_job(sys.argv[2])
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        if os.geteuid() != 0 and os.environ.get("LAE_DEV") != "1":
            raise SystemExit("worker requires root")
        run_archive_job(sys.argv[2])
        return
    if len(sys.argv) != 1:
        raise SystemExit("command-line arguments are not accepted")
    try:
        web_main()
    except SystemExit:
        raise
    except ValueError as exc:
        # Invalid/unsafe user input is a controlled refusal, not an application failure.
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        raise SystemExit(1)
    except Exception as exc:
        app_error("archive-helper.error", error=str(exc))
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
