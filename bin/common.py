#!/usr/bin/env python3
from __future__ import annotations

import configparser
import datetime as dt
import fcntl
import grp
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Iterable

PRODUCT = "Linux Archive Explorer"
SCHEMA_VERSION = 1
JOB_RE = re.compile(r"^[a-f0-9]{32}$")
UPLOAD_RE = re.compile(r"^[a-f0-9]{32}$")
FORMATS = {
    "tar.gz": (".tar.gz", ["--gzip"]),
    "tar.zst": (".tar.zst", ["--zstd"]),
    "tar.xz": (".tar.xz", ["--xz"]),
    "tar": (".tar", []),
    "zip": (".zip", []),
}
KNOWN_SUFFIXES = (".tar.gz", ".tgz", ".tar.zst", ".tzst", ".tar.xz", ".txz", ".tar", ".zip")


def release_version() -> str:
    path = Path(__file__).resolve().parents[1] / "VERSION"
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"release VERSION is unavailable: {path}") from exc
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", value):
        raise RuntimeError(f"release VERSION is invalid: {value!r}")
    return value


RELEASE_VERSION = release_version()
PSEUDO_PREFIXES = ("/proc", "/sys", "/dev", "/run")
CRITICAL_PREFIXES = (
    "/etc", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib64",
    "/var/www/linux-archive-explorer", "/etc/apache2", "/etc/nginx", "/etc/systemd",
)


def config_path() -> str:
    return os.environ.get("LAE_CONFIG", "/var/www/linux-archive-explorer/config.ini")


def _ini_text(cp: configparser.ConfigParser, section: str, key: str, fallback: str = "") -> str:
    """Return an INI string consistently with PHP parse_ini_file().

    ConfigParser intentionally preserves surrounding quotes while PHP strips
    them.  config.ini is shared by both runtimes, so normalize quoted string
    values here to keep every path and setting identical.
    """
    value = cp.get(section, key, fallback=fallback).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"\"", "'"}:
        value = value[1:-1]
        if value and cp.get(section, key, fallback=fallback).lstrip().startswith('"'):
            value = value.replace('\\"', '"').replace('\\\\', '\\')
    return value


CONFIG_LOAD_ERROR: str | None = None

def load_config() -> dict[str, Any]:
    global CONFIG_LOAD_ERROR
    path = config_path()
    cp = configparser.ConfigParser(interpolation=None)
    if not os.path.isfile(path):
        if os.environ.get("LAE_DEV") == "1":
            root = Path(__file__).resolve().parents[1]
            return {
                "root": str(root),
                "jobs": str(root / ".dev" / "jobs"),
                "staging": str(root / ".dev" / "staging"),
                "uploads": str(root / ".dev" / "uploads"),
                "archives": str(root / ".dev" / "archives"),
                "rollback": str(root / ".dev" / "rollback"),
                "logs": str(root / ".dev" / "logs"),
                "version": RELEASE_VERSION,
                "web_group": os.environ.get("LAE_WEB_GROUP", "www-data"),
                "log_max_bytes": 5 * 1024 * 1024,
                "log_backups": 2,
            }
        raise RuntimeError(f"configuration not found: {path}")
    try:
        cp.read(path, encoding="utf-8")
    except (configparser.Error, UnicodeError, OSError) as exc:
        # Recovery mode: keep read-only browsing and the protected text editor
        # available so an Administrator can repair a malformed live config.ini.
        # Mutating/helper actions are blocked by archive-helper.py until the
        # configuration parses successfully again.
        CONFIG_LOAD_ERROR = f"{type(exc).__name__}: {exc}"
        root = os.path.dirname(os.path.abspath(path))
        return {
            "root": root,
            "jobs": f"{root}/jobs",
            "staging": f"{root}/staging",
            "uploads": f"{root}/uploads",
            "archives": f"{root}/archives",
            "rollback": f"{root}/rollback",
            "logs": f"{root}/logs",
            "version": RELEASE_VERSION,
            "web_group": "www-data",
            "log_max_bytes": 5 * 1024 * 1024,
            "log_backups": 2,
        }
    CONFIG_LOAD_ERROR = None
    root = _ini_text(cp, "paths", "root", "/var/www/linux-archive-explorer")
    cfg = {
        "root": root,
        "jobs": _ini_text(cp, "paths", "jobs", f"{root}/jobs"),
        "staging": _ini_text(cp, "paths", "staging", f"{root}/staging"),
        "uploads": _ini_text(cp, "paths", "uploads", f"{root}/uploads"),
        "archives": _ini_text(cp, "paths", "archives", f"{root}/archives"),
        "rollback": _ini_text(cp, "paths", "rollback", f"{root}/rollback"),
        "logs": _ini_text(cp, "paths", "logs", f"{root}/logs"),
        "version": RELEASE_VERSION,
        "web_group": _ini_text(cp, "system", "web_group", "www-data"),
        "log_max_bytes": cp.getint("logging", "max_bytes", fallback=5 * 1024 * 1024),
        "log_backups": cp.getint("logging", "backups", fallback=2),
    }
    return cfg


CFG = load_config()
ROOT = os.path.abspath(str(CFG["root"]))
JOBS = os.path.abspath(str(CFG["jobs"]))
STAGING = os.path.abspath(str(CFG["staging"]))
UPLOADS = os.path.abspath(str(CFG["uploads"]))
ARCHIVES = os.path.abspath(str(CFG["archives"]))
ROLLBACK = os.path.abspath(str(CFG["rollback"]))
LOGS = os.path.abspath(str(CFG["logs"]))
RECOVERY = os.path.join(ROOT, "recovery")
APP_LOGS = os.path.join(LOGS, "app")
AUDIT_LOGS = os.path.join(LOGS, "audit")
try:
    WEB_GID = grp.getgrnam(str(CFG["web_group"])).gr_gid
except KeyError:
    WEB_GID = os.getgid()


def ensure_runtime_dirs() -> None:
    # These modes intentionally mirror the installer.  Runtime checks must
    # never silently tighten/loosen a directory and break another component.
    specs = (
        (JOBS, 0o750, WEB_GID), (STAGING, 0o750, WEB_GID), (UPLOADS, 0o2770, WEB_GID),
        (ARCHIVES, 0o750, WEB_GID), (ROLLBACK, 0o700, 0), (LOGS, 0o755, 0),
        (APP_LOGS, 0o2770, WEB_GID), (AUDIT_LOGS, 0o700, 0),
    )
    for path, mode, gid in specs:
        os.makedirs(path, mode=mode, exist_ok=True)
        if os.geteuid() == 0:
            try:
                os.chown(path, 0, gid)
                os.chmod(path, mode)
            except OSError:
                pass


def emit(data: dict[str, Any], code: int = 0) -> None:
    sysout = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    print(sysout, flush=True)
    raise SystemExit(code)


def read_request(max_bytes: int = 2 * 1024 * 1024) -> dict[str, Any]:
    raw = os.read(0, max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError("request is too large")
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("request must be valid JSON") from exc
    if not isinstance(data, dict):
        raise ValueError("request must be a JSON object")
    return data


def validate_abs(path: Any) -> str:
    if not isinstance(path, str) or not path or "\x00" in path:
        raise ValueError("invalid path")
    if not path.startswith("/"):
        raise ValueError("path must be absolute")
    if ".." in path.split("/"):
        raise ValueError("parent path components are not allowed")
    clean = os.path.normpath(path)
    if not clean.startswith("/"):
        raise ValueError("invalid absolute path")
    return clean


def under(path: str, prefix: str) -> bool:
    p = os.path.normpath(path)
    q = os.path.normpath(prefix)
    return p == q or p.startswith(q.rstrip("/") + "/")


def is_pseudo(path: str) -> bool:
    return any(under(path, p) for p in PSEUDO_PREFIXES)


def is_internal_runtime(path: str) -> bool:
    return any(under(path, p) for p in (JOBS, STAGING, UPLOADS, ROLLBACK, LOGS, RECOVERY))


def is_critical(path: str) -> bool:
    return any(under(path, p) or under(p, path) for p in CRITICAL_PREFIXES)


def safe_archive_name(name: Any, fmt: str) -> tuple[str, str]:
    if not isinstance(name, str):
        raise ValueError("archive name is required")
    name = name.strip()
    if not name or len(name) > 160:
        raise ValueError("archive name must be 1 to 160 characters")
    if name in (".", "..") or "/" in name or "\\" in name or any(ord(c) < 32 for c in name):
        raise ValueError("archive name contains invalid characters")
    if fmt not in FORMATS:
        raise ValueError("unsupported archive format")
    low = name.lower()
    for suffix in KNOWN_SUFFIXES:
        if low.endswith(suffix):
            name = name[:-len(suffix)].rstrip()
            break
    if not name:
        raise ValueError("archive name cannot consist only of an extension")
    return name, name + FORMATS[fmt][0]


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path: str, data: dict[str, Any], mode: int = 0o640, gid: int | None = None) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        if os.geteuid() == 0:
            os.chown(tmp, 0, WEB_GID if gid is None else gid)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def valid_job_id(job_id: str) -> bool:
    return bool(JOB_RE.fullmatch(job_id or ""))


def job_path(job_id: str) -> str:
    if not valid_job_id(job_id):
        raise ValueError("invalid job id")
    return os.path.join(JOBS, f"{job_id}.json")


def load_job(job_id: str) -> dict[str, Any]:
    path = job_path(job_id)
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("job record is invalid")
    return data


def save_job(job: dict[str, Any]) -> None:
    job["updated_at"] = int(time.time())
    atomic_json(job_path(str(job["id"])), job)


def set_job(job: dict[str, Any], status: str, message: str, **extra: Any) -> None:
    job["status"] = status
    job["message"] = message
    job.update(extra)
    save_job(job)


def new_job(kind: str, **fields: Any) -> dict[str, Any]:
    job_id = uuid.uuid4().hex
    now = int(time.time())
    job = {"id": job_id, "kind": kind, "status": "queued", "message": "Queued", "created_at": now, "updated_at": now}
    job.update(fields)
    save_job(job)
    return job


def _log_directory(name: str) -> str:
    if name == "audit.log":
        return AUDIT_LOGS
    if name == "app-error.log":
        return APP_LOGS
    raise ValueError("invalid log name")


def _log_lock_path(name: str) -> str:
    return os.path.join(_log_directory(name), ".rotation.lock")


def _rotate_if_needed(path: str) -> None:
    max_bytes = max(256 * 1024, int(CFG.get("log_max_bytes", 5 * 1024 * 1024)))
    backups = max(1, min(10, int(CFG.get("log_backups", 2))))
    now = dt.datetime.now()
    rotate = False
    try:
        st = os.stat(path)
        old = dt.datetime.fromtimestamp(st.st_mtime)
        rotate = old.date() != now.date() or st.st_size >= max_bytes
    except FileNotFoundError:
        pass
    if not rotate:
        return
    oldest = f"{path}.{backups}"
    try:
        os.unlink(oldest)
    except FileNotFoundError:
        pass
    for idx in range(backups - 1, 0, -1):
        src, dst = f"{path}.{idx}", f"{path}.{idx + 1}"
        if os.path.exists(src):
            os.replace(src, dst)
    if os.path.exists(path):
        os.replace(path, f"{path}.1")


def write_log(name: str, event: str, details: dict[str, Any] | None = None, mode: int = 0o640, gid: int = 0) -> None:
    ensure_runtime_dirs()
    if not re.fullmatch(r"[a-z0-9-]+\.log", name):
        raise ValueError("invalid log name")
    directory = _log_directory(name)
    path = os.path.join(directory, name)
    lock_path = _log_lock_path(name)
    with open(lock_path, "a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        _rotate_if_needed(path)
        record: dict[str, Any] = {
            "time": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "event": event,
        }
        if details:
            record["details"] = details
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            fh.flush()
        if os.geteuid() == 0:
            try:
                os.chown(path, 0, gid)
                os.chmod(path, mode)
            except OSError:
                pass
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def audit(event: str, **details: Any) -> None:
    try:
        write_log("audit.log", event, details, mode=0o640, gid=0)
    except Exception:
        pass


def app_error(event: str, **details: Any) -> None:
    try:
        write_log("app-error.log", event, details, mode=0o640, gid=WEB_GID)
    except Exception:
        pass


def os_release() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        with open("/etc/os-release", "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k] = v.strip().strip('"')
    except OSError:
        pass
    return out


def owner_names(st: os.stat_result) -> tuple[str, str]:
    import pwd
    try:
        user = pwd.getpwuid(st.st_uid).pw_name
    except KeyError:
        user = str(st.st_uid)
    try:
        group = grp.getgrgid(st.st_gid).gr_name
    except KeyError:
        group = str(st.st_gid)
    return user, group


def fsync_copy(src: str, dst: str, mode: int = 0o640) -> None:
    directory = os.path.dirname(dst)
    os.makedirs(directory, exist_ok=True)
    tmp = os.path.join(directory, f".{os.path.basename(dst)}.part-{uuid.uuid4().hex[:8]}")
    try:
        with open(src, "rb") as inf, open(tmp, "xb") as outf:
            shutil.copyfileobj(inf, outf, 1024 * 1024)
            outf.flush()
            os.fsync(outf.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, dst)
        dirfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def tar_cmd_for(path: str) -> list[str]:
    # GNU tar auto-detects gzip/xz; zstd detection is available on supported Debian 13.
    return ["/usr/bin/tar", "--file", path]


def is_zip_archive(path: str) -> bool:
    return str(path).lower().endswith(".zip")


def list_archive_members(path: str, limit: int = 200000) -> tuple[list[str], bool]:
    if is_zip_archive(path):
        try:
            with zipfile.ZipFile(path, "r") as zf:
                names = zf.namelist()
        except (OSError, zipfile.BadZipFile) as exc:
            raise ValueError("ZIP archive listing failed") from exc
        truncated = len(names) > limit
        return names[:limit], truncated
    proc = subprocess.run(["/usr/bin/tar", "--list", "--file", path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace")
    if proc.returncode != 0:
        raise ValueError((proc.stderr or "archive listing failed").strip())
    lines = proc.stdout.splitlines()
    truncated = len(lines) > limit
    return lines[:limit], truncated


def validate_member_name(name: str) -> str:
    # Archives created by this app never use absolute paths or parent traversal.
    if not name or name.startswith("/") or "\x00" in name:
        raise ValueError(f"unsafe archive member: {name!r}")
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError(f"unsafe parent traversal in archive member: {name!r}")
    clean = "/".join(parts)
    if not clean:
        raise ValueError("empty archive member")
    return clean


def extract_manifest(path: str) -> dict[str, Any] | None:
    if is_zip_archive(path):
        try:
            with zipfile.ZipFile(path, "r") as zf:
                try:
                    raw = zf.read(".linux-archive-explorer/manifest.json")
                except KeyError:
                    return None
        except (OSError, zipfile.BadZipFile) as exc:
            raise ValueError("ZIP archive is invalid") from exc
        if len(raw) > 1024 * 1024:
            raise ValueError("archive manifest is too large")
    else:
        proc = subprocess.run(
            ["/usr/bin/tar", "--extract", "--to-stdout", "--file", path, ".linux-archive-explorer/manifest.json"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        )
        if proc.returncode != 0:
            return None
        if len(proc.stdout) > 1024 * 1024:
            raise ValueError("archive manifest is too large")
        raw = proc.stdout
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("archive manifest is invalid") from exc
    if not isinstance(data, dict):
        raise ValueError("archive manifest is invalid")
    return data


def disk_free(path: str) -> int:
    return int(shutil.disk_usage(path).free)


def absolute_member(member: str) -> str:
    clean = validate_member_name(member)
    return "/" + clean


def selected_from_manifest(manifest: dict[str, Any]) -> list[str]:
    raw = manifest.get("selected_paths")
    if not isinstance(raw, list) or not raw:
        raise ValueError("archive manifest does not contain selected paths")
    out: list[str] = []
    for value in raw:
        p = validate_abs(value)
        if p == "/" or is_pseudo(p) or is_internal_runtime(p):
            raise ValueError(f"manifest contains unsafe selected path: {p}")
        out.append(p)
    return out


def public_system_info() -> dict[str, Any]:
    rel = os_release()
    return {
        "product": PRODUCT,
        "version": str(CFG.get("version", "0.0.0")),
        "hostname": platform.node(),
        "os": rel.get("PRETTY_NAME", platform.system()),
        "os_id": rel.get("ID", ""),
        "os_version": rel.get("VERSION_ID", ""),
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "tar": subprocess.run(["/usr/bin/tar", "--version"], stdout=subprocess.PIPE, text=True).stdout.splitlines()[0],
        "archive_storage": ARCHIVES,
        "free_bytes": disk_free(ARCHIVES if os.path.isdir(ARCHIVES) else ROOT),
    }
