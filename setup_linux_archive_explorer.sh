#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

PRODUCT="Linux Archive Explorer"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(tr -d '[:space:]' < "$SOURCE_DIR/VERSION" 2>/dev/null || true)"
APP_ROOT="/var/www/linux-archive-explorer"
CURRENT="$APP_ROOT/current"
CONFIG_DIR="$APP_ROOT/config"
CONFIG="$APP_ROOT/config.ini"
LEGACY_CONFIG="$CONFIG_DIR/config.ini"
DATA="$APP_ROOT/data"
DATA_RUNTIME="$DATA/runtime"
USERS_DB="$DATA/users.json"
JOBS="$APP_ROOT/jobs"
STAGING="$APP_ROOT/staging"
UPLOADS="$APP_ROOT/uploads"
ARCHIVES="$APP_ROOT/archives"
ROLLBACK="$APP_ROOT/rollback"
LOGS="$APP_ROOT/logs"
RECOVERY="$APP_ROOT/recovery"
RECOVERY_CONFIG="$RECOVERY/config.ini"
SYSTEMD_SERVICE="/etc/systemd/system/linux-archive-explorer-recovery.service"
CLEANUP_SERVICE="/etc/systemd/system/linux-archive-explorer-cleanup.service"
CLEANUP_TIMER="/etc/systemd/system/linux-archive-explorer-cleanup.timer"
APACHE_CONF="/etc/apache2/conf-available/linux-archive-explorer.conf"
SUDOERS="/etc/sudoers.d/linux-archive-explorer"
LOGROTATE_CONF="/etc/logrotate.d/linux-archive-explorer"
INSTALL_STATE_DIR="/var/lib/linux-archive-explorer"
INSTALL_STATE_META="$INSTALL_STATE_DIR/install-state.env"
INSTALL_STATE_PRE="$INSTALL_STATE_DIR/packages-before.txt"
INSTALL_STATE_ADDED="$INSTALL_STATE_DIR/packages-added.txt"
WEB_BASELINE_MARKER="$INSTALL_STATE_DIR/web-baseline.marker"
APACHE_LOG_PATCH_DIR="$INSTALL_STATE_DIR/apache-log-originals"
APACHE_LOG_PATCH_MANIFEST="$INSTALL_STATE_DIR/apache-log-patches.json"
TLS_DIR="/etc/linux-archive-explorer/tls"
TLS_SITE="/etc/apache2/sites-available/linux-archive-explorer-ssl.conf"
TLS_SITE_ENABLED="/etc/apache2/sites-enabled/linux-archive-explorer-ssl.conf"
TLS_CA="$TLS_DIR/local-ca.crt"
TLS_CERT="$TLS_DIR/server.crt"
TLS_KEY="$TLS_DIR/server.key"
SETUP_LOCK="/run/lock/linux-archive-explorer-setup.lock"
ARCHIVE_HELPER="$CURRENT/bin/archive-helper.py"
RESTORE_HELPER="$CURRENT/bin/restore-helper.py"
BASE_URL="/linux-archive-explorer/"
STAMP="$(date +%Y%m%d-%H%M%S)"
ACTION="${1:-}"
ORIGINAL_ARGS=("$@")
SCRIPT_PATH="$SOURCE_DIR/$(basename -- "${BASH_SOURCE[0]}")"
FRESH=0
MODIFIED=0
OLD_CURRENT=""
BACKUP_TAR=""
TMP_APACHE=""
TMP_SUDOERS=""
TMP_LOGROTATE=""
TMP_SYSTEMD=""
TMP_CLEANUP_SERVICE=""
TMP_CLEANUP_TIMER=""
APP_ROOT_PREEXISTED=0
# Bash EXIT traps are inherited by parenthesized subshells.  Record the main
# installer shell so cleanup/rollback can never run from a staging/check
# subshell and race the parent installer.
MAIN_BASHPID="$BASHPID"

say(){ [[ -z "$ACTION" || "$ACTION" == "--repair" ]] && return 0; printf '[Linux Archive Explorer] %s\n' "$*"; }
ok(){ [[ -z "$ACTION" || "$ACTION" == "--repair" ]] && return 0; printf '[OK] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }
die(){ printf '[ERROR] %s\n' "$*" >&2; exit 1; }
need_root(){ [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Run this installer with sudo or as root."; }

acquire_setup_lock(){
  command -v flock >/dev/null 2>&1 || die "Required command is missing: flock (util-linux)."
  mkdir -p -- "$(dirname -- "$SETUP_LOCK")"
  [[ "${LAE_SETUP_LOCK_HELD:-0}" == "1" ]] && return 0
  local rc
  set +e
  LAE_SETUP_LOCK_HELD=1 flock --exclusive --nonblock --close --conflict-exit-code 73 "$SETUP_LOCK" bash "$SCRIPT_PATH" "${ORIGINAL_ARGS[@]}"
  rc=$?
  set -e
  if [[ $rc -eq 73 ]]; then
    die "Another Linux Archive Explorer setup/verify/maintenance command is already running. Let it finish before trying again."
  fi
  exit "$rc"
}

assert_no_active_work(){
  [[ -d "$APP_ROOT" ]] || return 0
  local reasons=""
  if [[ -e "$JOBS/restore.lock" ]]; then
    reasons+=$'\n  - Restore/rollback lock is present.'
  fi
  if [[ -d "$CURRENT/bin" ]]; then
    if pgrep -af -- "$CURRENT/bin/restore-helper.py" >/dev/null 2>&1; then reasons+=$'\n  - Restore helper process is running.'; fi
    if pgrep -af -- "$CURRENT/bin/archive-helper.py" >/dev/null 2>&1; then reasons+=$'\n  - Archive/file-operation helper process is running.'; fi
  fi
  # On a minimal first install, Python may not be available until ensure_packages.
  # Never skip active-work protection on an existing installation: if metadata
  # cannot be inspected, refuse changes rather than proceeding blindly.
  if ! command -v python3 >/dev/null 2>&1; then
    if { [[ -d "$JOBS" ]] && find "$JOBS" -maxdepth 1 -type f -name '*.json' -print -quit | grep -q .; } ||
       { [[ -d "$UPLOADS" ]] && find "$UPLOADS" -maxdepth 1 -type f \( -name '*.json' -o -name '*.transfer.json' \) -print -quit | grep -q .; }; then
      die "Cannot inspect active job/upload metadata before Python 3 is installed. No changes were made."
    fi
    [[ -z "$reasons" ]] || { printf '[ERROR] Refusing lifecycle changes while work is active:%s\n' "$reasons" >&2; exit 1; }
    return 0
  fi
  local metadata_reasons
  metadata_reasons="$(python3 - "$JOBS" "$UPLOADS" <<'PYACTIVE'
import json, os, sys, time
jobs, uploads = sys.argv[1:3]
now=time.time(); recent=15*60
terminal={'completed','failed','warning','inspected','cancelled','canceled','error'}
reasons=[]
if os.path.isdir(jobs):
    for name in sorted(os.listdir(jobs)):
        if not name.endswith('.json'): continue
        path=os.path.join(jobs,name)
        try:
            mtime=os.path.getmtime(path)
            with open(path,encoding='utf-8') as f: obj=json.load(f)
            if not isinstance(obj,dict): raise ValueError('job metadata must be an object')
            status=str(obj.get('status','')).strip().lower()
            try: updated=float(obj.get('updated_at') or obj.get('created_at') or mtime)
            except (ValueError,TypeError): updated=mtime
            if status and status not in terminal and (now-updated <= recent):
                reasons.append(f"  - Active/recent job {name[:-5]}: {obj.get('kind','job')} / {status}.")
            elif not status and now-mtime <= recent:
                reasons.append(f"  - Recent job {name} lacks status metadata.")
        except (OSError,ValueError,TypeError,UnicodeError):
            # Fail closed on malformed recent metadata; don't turn a busy/failed
            # job into an unhandled Python exception or silently proceed.
            try: recent_file=now-os.path.getmtime(path)<=recent
            except OSError: recent_file=True
            if recent_file: reasons.append(f"  - Recent job {name} has unreadable/invalid metadata.")
if os.path.isdir(uploads):
    for name in sorted(os.listdir(uploads)):
        if not (name.endswith('.json') or name.endswith('.transfer.json')): continue
        path=os.path.join(uploads,name)
        try:
            with open(path,encoding='utf-8') as f: obj=json.load(f)
            if not isinstance(obj,dict): raise ValueError('upload metadata must be an object')
            complete=bool(obj.get('complete'))
            age=now-os.path.getmtime(path)
        except Exception:
            continue
        if not complete and age <= recent:
            reasons.append(f"  - Active/recent browser upload/transfer: {name}.")
print('\n'.join(reasons))
PYACTIVE
)"
  if [[ -n "$metadata_reasons" ]]; then reasons+=$'\n'"$metadata_reasons"; fi
  if [[ -n "$reasons" ]]; then
    printf '[ERROR] Refusing lifecycle changes while Linux Archive Explorer work is active:%s\n' "$reasons" >&2
    printf '[ERROR] Let the active operation finish (or recover it safely) before install/update/repair/uninstall. No changes were made.\n' >&2
    exit 1
  fi
}

cleanup_tmp(){
  [[ -n "$TMP_APACHE" ]] && rm -f -- "$TMP_APACHE" 2>/dev/null || true
  [[ -n "$TMP_SUDOERS" ]] && rm -f -- "$TMP_SUDOERS" 2>/dev/null || true
  [[ -n "$TMP_LOGROTATE" ]] && rm -f -- "$TMP_LOGROTATE" 2>/dev/null || true
  [[ -n "$TMP_SYSTEMD" ]] && rm -f -- "$TMP_SYSTEMD" 2>/dev/null || true
  [[ -n "$TMP_CLEANUP_SERVICE" ]] && rm -f -- "$TMP_CLEANUP_SERVICE" 2>/dev/null || true
  [[ -n "$TMP_CLEANUP_TIMER" ]] && rm -f -- "$TMP_CLEANUP_TIMER" 2>/dev/null || true
  rm -rf -- "$APP_ROOT/.release-new.$$" 2>/dev/null || true
}

reload_apache(){
  # Successful install/update must stay quiet. Capture Apache/systemd output and
  # show it only when the start/reload itself fails.
  local apache_log rc=0
  apache_log="$(mktemp)"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    if systemctl is-active --quiet apache2 2>/dev/null; then
      systemctl reload apache2 >"$apache_log" 2>&1 || rc=$?
    else
      systemctl start apache2 >"$apache_log" 2>&1 || rc=$?
    fi
  elif pgrep -x apache2 >/dev/null 2>&1; then
    apache2ctl graceful >"$apache_log" 2>&1 || rc=$?
  else
    apache2ctl start >"$apache_log" 2>&1 || rc=$?
  fi
  if [[ $rc -ne 0 ]]; then
    cat "$apache_log" >&2
    rm -f -- "$apache_log"
    return "$rc"
  fi
  rm -f -- "$apache_log"
}

rollback_install(){
  local rc="${1:-1}"
  cleanup_tmp
  if [[ $MODIFIED -eq 1 ]]; then
    printf '\n[Linux Archive Explorer] Installation/update failed; restoring the previous state.\n' >&2
    restore_apache_access_log_patches 1 || true
    a2disconf linux-archive-explorer >/dev/null 2>&1 || true
    a2dissite linux-archive-explorer-ssl >/dev/null 2>&1 || true
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then systemctl disable linux-archive-explorer-recovery.service >/dev/null 2>&1 || true; systemctl disable --now linux-archive-explorer-cleanup.timer >/dev/null 2>&1 || true; fi
    rm -f -- "$APACHE_CONF" "$TLS_SITE" "$SUDOERS" "$LOGROTATE_CONF" "$SYSTEMD_SERVICE" "$CLEANUP_SERVICE" "$CLEANUP_TIMER" 2>/dev/null || true
    rm -rf -- "$TLS_DIR" 2>/dev/null || true
    rm -rf -- "$CURRENT" 2>/dev/null || true
    if [[ -n "$OLD_CURRENT" && -d "$OLD_CURRENT" ]]; then
      mv "$OLD_CURRENT" "$CURRENT" || true
    fi
    if [[ -n "$BACKUP_TAR" && -f "$BACKUP_TAR" ]]; then
      # Restore an exact pre-update state. Remove mutable trees that the failed
      # version may have created files in so tar extraction cannot leave new
      # files (for example a newly introduced users.json) behind.
      rm -f -- "$CONFIG" 2>/dev/null || true
      rm -rf -- "$CONFIG_DIR" "$DATA" "$RECOVERY" 2>/dev/null || true
      tar --extract --gzip --acls --xattrs --numeric-owner --file="$BACKUP_TAR" --directory=/ || true
    elif [[ $FRESH -eq 1 ]]; then
      if [[ $APP_ROOT_PREEXISTED -eq 1 ]]; then
        # A prior uninstall may have intentionally preserved archives/rollback.
        # Never erase those because a later fresh reinstall failed.
        rm -f -- "$CONFIG" 2>/dev/null || true
        rm -rf -- "$CURRENT" "$CONFIG_DIR" "$DATA" "$JOBS" "$STAGING" "$UPLOADS" "$LOGS" "$RECOVERY" 2>/dev/null || true
      else
        # A fresh checkout lives inside APP_ROOT: never delete source/.git
        # after an installation failure. Keep the checkout recoverable.
        rm -f -- "$CONFIG" 2>/dev/null || true
        rm -rf -- "$CURRENT" "$CONFIG_DIR" "$DATA" "$JOBS" "$STAGING" \
          "$UPLOADS" "$ARCHIVES" "$ROLLBACK" "$LOGS" "$RECOVERY" 2>/dev/null || true
      fi
    fi
    if [[ -f "$APACHE_CONF" ]]; then a2enconf linux-archive-explorer >/dev/null 2>&1 || true; fi
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then systemctl daemon-reload >/dev/null 2>&1 || true; [[ -f "$SYSTEMD_SERVICE" ]] && systemctl enable linux-archive-explorer-recovery.service >/dev/null 2>&1 || true; [[ -f "$CLEANUP_TIMER" ]] && systemctl enable --now linux-archive-explorer-cleanup.timer >/dev/null 2>&1 || true; fi
    apache2ctl configtest >/dev/null 2>&1 && reload_apache || true
    printf '[Linux Archive Explorer] Rollback attempted.\n' >&2
    [[ -n "$BACKUP_TAR" ]] && printf '[Linux Archive Explorer] Protected backup: %s\n' "$BACKUP_TAR" >&2
  fi
  return "$rc"
}

on_exit(){
  local rc=$?
  # Never let a child/subshell run the parent installer cleanup/rollback.
  # BASHPID changes in Bash subshells while $$ does not.
  if [[ "$BASHPID" != "$MAIN_BASHPID" ]]; then
    return "$rc"
  fi
  trap - EXIT INT TERM
  if [[ $rc -ne 0 && $MODIFIED -eq 1 ]]; then
    rollback_install "$rc" || true
  else
    cleanup_tmp
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

usage(){ cat <<EOF
$PRODUCT installer v$VERSION

Usage (run from $APP_ROOT):
  sudo ./setup_linux_archive_explorer.sh                  Install or update with concise progress output
  sudo ./setup_linux_archive_explorer.sh --repair         Repair code/integration; preserve data
  sudo ./setup_linux_archive_explorer.sh --verify         Detailed installation verification
  sudo ./setup_linux_archive_explorer.sh --change-password
  sudo ./setup_linux_archive_explorer.sh --uninstall      Permanently remove LAE and safely reverse proven first-install packages
  sudo ./setup_linux_archive_explorer.sh --help           Display usage

Normal installation/updating preserves existing configuration, accounts, archives and recovery data.
Uninstall permanently deletes the full application directory and its stored data. When a valid first-install ledger exists, only packages proven to have been introduced by Linux Archive Explorer are considered for safe reversal. Apache/PHP are removed only when LAE introduced the web stack and no other web application/configuration is detected; otherwise shared or pre-existing packages are preserved.
EOF
}

check_source(){
  [[ "$SOURCE_DIR" == "$APP_ROOT" ]] || die "Run setup from $APP_ROOT. The application uses one permanent directory; see README.md for migration instructions."
  [[ -n "$VERSION" ]] || die "VERSION is missing."
  [[ -f "$SOURCE_DIR/config.ini.example" ]] || die "config.ini.example is missing."
  [[ -f "$SOURCE_DIR/public/index.php" && -f "$SOURCE_DIR/app/bootstrap.php" ]] || die "Run the installer from the extracted release directory."
  [[ -x "$SOURCE_DIR/bin/archive-helper.py" && -x "$SOURCE_DIR/bin/restore-helper.py" ]] || die "Privileged helper files are missing or not executable."
  # This directory also contains runtime/recovery trees and .git; inspect only
  # immutable source payload, not user archives or other managed runtime data.
  if find "$SOURCE_DIR/app" "$SOURCE_DIR/bin" "$SOURCE_DIR/public" -type l -print -quit | grep -q .; then
    die "Release source contains a symbolic link; source must contain regular files/directories only."
  fi
  if [[ -f "$SOURCE_DIR/SHA256SUMS" ]]; then
    (cd "$SOURCE_DIR" && sha256sum -c SHA256SUMS >/dev/null) || die "Release SHA256SUMS validation failed."
  fi
  find "$SOURCE_DIR/app" "$SOURCE_DIR/public" -name '*.php' -print0 | xargs -0 -n1 php -l >/dev/null
  python3 -m py_compile "$SOURCE_DIR/bin/common.py" "$SOURCE_DIR/bin/archive-helper.py" "$SOURCE_DIR/bin/restore-helper.py"
  rm -rf "$SOURCE_DIR/bin/__pycache__" 2>/dev/null || true
  if command -v node >/dev/null 2>&1; then
    node --check "$SOURCE_DIR/public/assets/app.js" >/dev/null || die "JavaScript syntax check failed."
  fi
}

detect_platform(){
  [[ -r /etc/os-release ]] || die "Cannot identify this Linux distribution."
  local distro_id distro_version arch
  # Read os-release in a subshell so generic names such as VERSION cannot
  # overwrite installer variables.
  distro_id="$(. /etc/os-release; printf '%s' "${ID:-}")"
  distro_version="$(. /etc/os-release; printf '%s' "${VERSION_ID:-}")"
  [[ "$distro_id" == "debian" && "$distro_version" == "13" ]] || die "v$VERSION is certified for Debian 13 only. The application is distribution-aware, but unsupported distributions are intentionally refused until tested."
  arch="$(dpkg --print-architecture 2>/dev/null || true)"
  [[ "$arch" == "amd64" || "$arch" == "arm64" ]] || die "Certified architectures are Debian 13 amd64 and arm64; detected: ${arch:-unknown}."
  ok "Platform: Debian 13 / $arch"
}

init_install_state(){
  # install.sh normally creates this before bootstrap packages are installed.
  # Direct fresh setup still records a conservative baseline, but never claims
  # /var/www itself was absent before a source checkout already placed here.
  [[ $FRESH -eq 1 ]] || return 0
  install -d -o root -g root -m 0700 "$INSTALL_STATE_DIR"
  if [[ ! -f "$INSTALL_STATE_PRE" ]]; then
    dpkg-query -W -f='${binary:Package}\n' 2>/dev/null | LC_ALL=C sort -u > "$INSTALL_STATE_PRE"
    chmod 0600 "$INSTALL_STATE_PRE"
  fi
  if [[ ! -f "$INSTALL_STATE_META" ]]; then
    local apache_preinstalled=0 apache_was_active=0
    dpkg-query -W -f='${Status}' apache2 2>/dev/null | grep -qx 'install ok installed' && apache_preinstalled=1 || true
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
      systemctl is-active --quiet apache2 2>/dev/null && apache_was_active=1 || true
    elif pgrep -x apache2 >/dev/null 2>&1; then
      apache_was_active=1
    fi
    {
      printf 'LAE_INSTALL_STATE_VERSION=1\n'
      printf 'VAR_WWW_PREEXISTED=1\n'
      printf 'APACHE_PREINSTALLED=%s\n' "$apache_preinstalled"
      printf 'APACHE_WAS_ACTIVE=%s\n' "$apache_was_active"
      printf 'CREATED_BY=setup_linux_archive_explorer.sh\n'
    } > "$INSTALL_STATE_META"
    chmod 0600 "$INSTALL_STATE_META"
  fi
}

finalize_install_state(){
  [[ -f "$INSTALL_STATE_PRE" ]] || return 0
  local now
  now="$(mktemp)"
  dpkg-query -W -f='${binary:Package}\n' 2>/dev/null | LC_ALL=C sort -u > "$now"
  LC_ALL=C comm -13 <(LC_ALL=C sort -u "$INSTALL_STATE_PRE") <(LC_ALL=C sort -u "$now") > "$INSTALL_STATE_ADDED"
  rm -f -- "$now"
  chmod 0600 "$INSTALL_STATE_ADDED"
}

prepare_clean_uninstall(){
  CLEAN_PACKAGES=()
  CLEAN_VAR_WWW=1
  CLEAN_APACHE_PREINSTALLED=1
  CLEAN_APACHE_WAS_ACTIVE=1
  CLEAN_PRESERVE_WEB=1
  # Older/existing installations may not have a complete first-install ledger.
  # In that case uninstall still removes LAE, but package reversal is skipped.
  [[ -f "$INSTALL_STATE_META" && -f "$INSTALL_STATE_ADDED" ]] || return 0
  # shellcheck disable=SC1090
  . "$INSTALL_STATE_META"
  [[ "${LAE_INSTALL_STATE_VERSION:-}" == "1" ]] || die "Unsupported install-state ledger; refusing package removal."
  local preserve_web=1 p
  if [[ "${APACHE_PREINSTALLED:-1}" == "0" ]] && ! web_stack_has_other_users; then preserve_web=0; fi
  mapfile -t CLEAN_PACKAGES < <(while IFS= read -r p; do
    if [[ "$preserve_web" == "1" ]]; then
      case "$p" in apache2|apache2-*|php|php-*|libapache2-mod-php*|openssl) continue ;; esac
    fi
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -qx 'install ok installed' && printf '%s\n' "$p" || true
  done < "$INSTALL_STATE_ADDED")
  CLEAN_VAR_WWW="${VAR_WWW_PREEXISTED:-1}"
  CLEAN_APACHE_PREINSTALLED="${APACHE_PREINSTALLED:-1}"
  CLEAN_APACHE_WAS_ACTIVE="${APACHE_WAS_ACTIVE:-1}"
  CLEAN_PRESERVE_WEB="$preserve_web"
  if [[ "$preserve_web" == "1" && "${APACHE_PREINSTALLED:-1}" == "0" ]]; then
    warn 'Apache/PHP were introduced by LAE, but other web content/configuration is now present; the web stack will be preserved.'
  fi
  if ((${#CLEAN_PACKAGES[@]})); then
    local sim proposed bad=0 pkg
    sim="$(mktemp)"
    DEBIAN_FRONTEND=noninteractive apt-get -s purge "${CLEAN_PACKAGES[@]}" > "$sim" 2>&1 || { cat "$sim" >&2; rm -f "$sim"; die "APT could not safely simulate first-install package reversal."; }
    mapfile -t proposed < <(awk '/^(Remv|Purg) /{print $2}' "$sim" | LC_ALL=C sort -u)
    rm -f -- "$sim"
    local -A clean_allowed=()
    # dpkg-query may record Multi-Arch package names with an architecture suffix
    # (for example libapr1t64:arm64), while APT simulation reports the same
    # package without that suffix. Compare canonical binary package names so a
    # package LAE demonstrably added is not falsely treated as unrecorded.
    for pkg in "${CLEAN_PACKAGES[@]}"; do
      clean_allowed["${pkg%%:*}"]=1
    done
    for pkg in "${proposed[@]}"; do
      [[ -n "${clean_allowed[${pkg%%:*}]+x}" ]] || { warn "APT would also remove unrecorded package: $pkg"; bad=1; }
    done
    [[ $bad -eq 0 ]] || die "Refusing package reversal because APT proposed removing packages not proven to have been added by Linux Archive Explorer."
  fi
}

finish_clean_uninstall(){
  local pkg
  if ((${#CLEAN_PACKAGES[@]})); then
    DEBIAN_FRONTEND=noninteractive apt-get -y purge "${CLEAN_PACKAGES[@]}" >/dev/null || die "Linux Archive Explorer was removed, but package reversal failed. Install-state ledger was retained at $INSTALL_STATE_DIR for recovery."
  fi
  # Do not stop a preserved Apache service during uninstall. Another application
  # may have started using it after LAE was installed.
  #
  # A GitHub checkout may have required creating /var/www before setup began, so
  # VAR_WWW_PREEXISTED can legitimately be 1 even when the machine had no web
  # root before the LAE checkout. When LAE introduced Apache and no other web
  # application now claims the stack, reclaim /var/www only if it contains
  # nothing except Debian Apache's untouched stock document root. This is safe
  # for both bootstrap installs and clone-then-setup installs, and it never
  # removes user web content.
  if [[ "$CLEAN_PRESERVE_WEB" == "0" && -d /var/www ]]; then
    if [[ -d /var/www/html ]] && ! find /var/www -mindepth 1 \
        ! -path /var/www/html ! -path /var/www/html/index.html -print -quit 2>/dev/null | grep -q .; then
      rm -f -- /var/www/html/index.html 2>/dev/null || true
      rmdir /var/www/html 2>/dev/null || true
    fi
    if ! find /var/www -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
      rmdir /var/www 2>/dev/null || true
    fi
  fi
  rm -rf -- "$INSTALL_STATE_DIR"
  # Complete uninstall includes safe proven footprint reversal. Installer-created
  # external backup storage is LAE-owned state and must not remain behind.
  rm -rf -- /var/backups/linux-archive-explorer
}

file_tree_fingerprint(){
  local root="$1" exclude="${2:-}"
  [[ -d "$root" ]] || { printf 'absent\n'; return 0; }
  python3 - "$root" "$exclude" <<'PYFP'
import hashlib, os, stat, sys
root=os.path.realpath(sys.argv[1]); exclude=os.path.realpath(sys.argv[2]) if sys.argv[2] else None
h=hashlib.sha256()
for base, dirs, files in os.walk(root, topdown=True, followlinks=False):
    dirs.sort(); files.sort()
    if exclude:
        dirs[:] = [d for d in dirs if os.path.realpath(os.path.join(base,d)) != exclude and not os.path.realpath(os.path.join(base,d)).startswith(exclude+os.sep)]
    for name in dirs+files:
        path=os.path.join(base,name)
        rp=os.path.realpath(path)
        if exclude and (rp==exclude or rp.startswith(exclude+os.sep)): continue
        rel=os.path.relpath(path,root)
        try: st=os.lstat(path)
        except FileNotFoundError: continue
        h.update(rel.encode()+b'\0'+oct(stat.S_IMODE(st.st_mode)).encode()+b'\0')
        if stat.S_ISLNK(st.st_mode):
            h.update(b'L'+os.readlink(path).encode()+b'\0')
        elif stat.S_ISREG(st.st_mode):
            h.update(b'F'+str(st.st_size).encode()+b'\0')
            with open(path,'rb') as f:
                for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
        elif stat.S_ISDIR(st.st_mode): h.update(b'D')
print(h.hexdigest())
PYFP
}

record_web_baseline_after_bootstrap(){
  [[ -f "$INSTALL_STATE_META" ]] || return 0
  local apache_fp www_fp ssl_enabled=0
  apache_fp="$(file_tree_fingerprint /etc/apache2)"
  www_fp="$(file_tree_fingerprint /var/www "$APP_ROOT")"
  apache2ctl -M 2>/dev/null | grep -q ssl_module && ssl_enabled=1 || true
  {
    printf 'APACHE_BASELINE_FP=%q\n' "$apache_fp"
    printf 'VAR_WWW_BASELINE_FP=%q\n' "$www_fp"
    printf 'SSL_MODULE_WAS_ENABLED=%s\n' "$ssl_enabled"
  } >> "$INSTALL_STATE_META"
  touch "$WEB_BASELINE_MARKER"
  chmod 0600 "$WEB_BASELINE_MARKER"
}

web_stack_has_other_users(){
  # Return success when anything outside LAE changed the web-server baseline.
  [[ -f "$INSTALL_STATE_META" ]] || return 0
  # shellcheck disable=SC1090
  . "$INSTALL_STATE_META"
  [[ "${APACHE_PREINSTALLED:-1}" == "0" ]] || return 0
  local apache_now www_now
  # Temporarily ignore LAE-owned TLS/site/conf entries in the comparison by
  # testing for obvious non-LAE web content/configuration first. The Debian
  # package defaults are represented by the recorded baseline fingerprints.
  if find /var/www -mindepth 1 -maxdepth 4 \
      ! -path "$APP_ROOT" ! -path "$APP_ROOT/*" \
      -type f -newer "${WEB_BASELINE_MARKER:-$INSTALL_STATE_META}" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  # Enabled virtual hosts/configs that are not Debian's stock defaults or LAE
  # are treated as another web application's ownership claim.
  if find /etc/apache2/sites-enabled -maxdepth 1 -type l \
      ! -name '000-default.conf' ! -name 'default-ssl.conf' ! -name 'linux-archive-explorer-ssl.conf' \
      -print -quit 2>/dev/null | grep -q .; then return 0; fi
  if find /etc/apache2/conf-enabled -maxdepth 1 -type l \
      ! -name 'charset.conf' ! -name 'localized-error-pages.conf' ! -name 'other-vhosts-access-log.conf' \
      ! -name 'security.conf' ! -name 'serve-cgi-bin.conf' ! -name 'linux-archive-explorer.conf' \
      -print -quit 2>/dev/null | grep -q .; then return 0; fi
  return 1
}

detect_primary_ipv4(){
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}' || true)"
  fi
  [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  printf '%s\n' "$ip"
}

apache_access_log_filter_compatible(){
  # Every enabled CustomLog that writes Apache's main access.log must honor the
  # shared LAE polling flag; one compatible vhost is not enough because another
  # enabled vhost could still receive the same LAE request and grow access.log.
  local link target line found=0
  for link in /etc/apache2/sites-enabled/*.conf; do
    [[ -e "$link" ]] || continue
    target="$(readlink -f -- "$link" 2>/dev/null || true)"
    [[ -f "$target" ]] || continue
    while IFS= read -r line; do
      found=1
      [[ "$line" == *dontlog_app_polling_200* ]] || return 1
    done < <(grep -E '^[[:space:]]*CustomLog[[:space:]]+(\$\{APACHE_LOG_DIR\}/access\.log|/var/log/apache2/access\.log)[[:space:]]+' "$target" 2>/dev/null || true)
  done
  [[ $found -eq 1 ]]
}

patch_apache_access_log_if_needed(){
  # On a clean Debian install ensure_local_https creates LAE-owned vhosts whose
  # CustomLog already honors dontlog_app_polling_200. On an established Apache
  # host, prefer an existing compatible logging expression. Only when neither
  # exists do we make a narrowly scoped, reversible edit to simple access.log
  # CustomLog directives in enabled site files.
  apache_access_log_filter_compatible && return 0

  install -d -o root -g root -m 0700 "$APACHE_LOG_PATCH_DIR"
  local rc
  set +e
  python3 - "$APACHE_LOG_PATCH_DIR" "$APACHE_LOG_PATCH_MANIFEST" <<'PYAPATCH'
import base64, hashlib, json, os, re, shutil, sys, tempfile
backup_dir, manifest_path = sys.argv[1:3]
links=[]
for name in sorted(os.listdir('/etc/apache2/sites-enabled')):
    lp=os.path.join('/etc/apache2/sites-enabled', name)
    if not os.path.islink(lp):
        continue
    target=os.path.realpath(lp)
    if os.path.isfile(target) and target not in links:
        links.append(target)

# Only patch the common, unconditioned Apache access-log form. Complex or
# already-conditioned logging belongs to the administrator and is never guessed.
pat=re.compile(r'^(?P<indent>\s*)CustomLog\s+(?P<log>\$\{APACHE_LOG_DIR\}/access\.log|/var/log/apache2/access\.log)\s+(?P<fmt>[A-Za-z0-9_.-]+)\s*$', re.M)
condition='"expr=!(reqenv(\'dontlog_app_polling\') == \'1\' || (reqenv(\'dontlog_app_polling_200\') == \'1\' && %{REQUEST_STATUS} == 200))"'
entries=[]
patched_any=False
for path in links:
    text=open(path, encoding='utf-8').read()
    reps=[]
    def repl(m):
        nonlocal_dummy = None
        original=m.group(0)
        patched=f"{m.group('indent')}CustomLog {m.group('log')} {m.group('fmt')} {condition}"
        reps.append({'original':original,'patched':patched})
        return patched
    new=pat.sub(repl,text)
    if new==text:
        continue
    rel=path.lstrip('/').replace('/','__')
    bpath=os.path.join(backup_dir, rel)
    shutil.copy2(path,bpath)
    fd,tmp=tempfile.mkstemp(prefix='.lae-log-',dir=os.path.dirname(path),text=True)
    try:
        with os.fdopen(fd,'w',encoding='utf-8',newline='') as f: f.write(new)
        st=os.stat(path)
        os.chown(tmp,st.st_uid,st.st_gid); os.chmod(tmp,st.st_mode & 0o7777)
        os.replace(tmp,path)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
    entries.append({'path':path,'backup':bpath,'replacements':reps})
    patched_any=True
if not patched_any:
    raise SystemExit(42)
os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
with open(manifest_path,'w',encoding='utf-8') as f: json.dump({'version':1,'entries':entries},f,indent=2,sort_keys=True)
os.chmod(manifest_path,0o600)
PYAPATCH
  rc=$?
  set -e
  if [[ $rc -eq 42 ]]; then
    rm -rf -- "$APACHE_LOG_PATCH_DIR"
    die "Apache access.log is active but no compatible LAE suppression expression exists, and the enabled CustomLog is too customized to edit safely. LAE made no logging change."
  elif [[ $rc -ne 0 ]]; then
    [[ -f "$APACHE_LOG_PATCH_MANIFEST" ]] || rm -rf -- "$APACHE_LOG_PATCH_DIR"
    die "Could not install the reversible LAE access-log suppression integration."
  fi
  apache2ctl configtest >/dev/null 2>&1 || { restore_apache_access_log_patches 1; die 'Apache logging integration failed configuration validation.'; }
  reload_apache
  apache_access_log_filter_compatible || die 'LAE access-log suppression could not be activated.'
}

restore_apache_access_log_patches(){
  local best_effort="${1:-0}"
  [[ -f "$APACHE_LOG_PATCH_MANIFEST" ]] || return 0
  local rc
  set +e
  python3 - "$APACHE_LOG_PATCH_MANIFEST" <<'PYAUNPATCH'
import json, os, sys, tempfile
manifest=sys.argv[1]
data=json.load(open(manifest,encoding='utf-8'))
for ent in data.get('entries',[]):
    path=ent['path']
    if not os.path.isfile(path):
        raise SystemExit(f'Patched Apache file is missing: {path}')
    text=open(path,encoding='utf-8').read()
    for rep in ent.get('replacements',[]):
        patched=rep['patched']; original=rep['original']
        if patched in text:
            text=text.replace(patched,original,1)
        elif original in text:
            continue
        else:
            raise SystemExit(f'Cannot safely reverse LAE logging change in {path}; the patched directive was changed after installation.')
    fd,tmp=tempfile.mkstemp(prefix='.lae-unlog-',dir=os.path.dirname(path),text=True)
    try:
        with os.fdopen(fd,'w',encoding='utf-8',newline='') as f: f.write(text)
        st=os.stat(path); os.chown(tmp,st.st_uid,st.st_gid); os.chmod(tmp,st.st_mode & 0o7777)
        os.replace(tmp,path)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
PYAUNPATCH
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    if [[ "$best_effort" == "1" ]]; then
      warn 'Could not automatically reverse the LAE Apache logging patch during rollback; protected originals remain in the install-state directory.'
      return 0
    fi
    die 'Refusing to overwrite later Apache logging changes while removing LAE. Restore/reconcile the protected logging original first.'
  fi
  rm -f -- "$APACHE_LOG_PATCH_MANIFEST"
  rm -rf -- "$APACHE_LOG_PATCH_DIR"
}

ensure_local_https(){
  # Existing working HTTPS always wins; never replace another application's TLS.
  if apache2ctl -M 2>/dev/null | grep -q ssl_module && apache2ctl -S 2>&1 | grep -q ':443'; then
    return 0
  fi
  local ip host
  ip="$(detect_primary_ipv4)"; host="$(hostname -s 2>/dev/null || hostname)"
  [[ -n "$ip" ]] || { say 'Could not determine a LAN IPv4 address; full Windows folder browsing will require separately configured HTTPS.'; return 0; }
  if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)443$'; then
    say 'TCP port 443 is already used outside this Apache configuration; LAE did not take it over. Configure trusted HTTPS separately for full Windows folder browsing.'
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || die 'openssl is required to provision the isolated local HTTPS endpoint.'
  install -d -o root -g root -m 0700 "$TLS_DIR"
  if [[ ! -s "$TLS_CA" || ! -s "$TLS_CERT" || ! -s "$TLS_KEY" ]]; then
    local ext
    ext="$(mktemp)"
    cat > "$ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$ip,DNS:$host
EOF
    openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
      -subj "/CN=Linux Archive Explorer Local CA ($host)" \
      -addext 'basicConstraints=critical,CA:TRUE' \
      -addext 'keyUsage=critical,keyCertSign,cRLSign' \
      -keyout "$TLS_DIR/local-ca.key" -out "$TLS_CA" >/dev/null 2>&1
    openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=$ip" \
      -keyout "$TLS_KEY" -out "$TLS_DIR/server.csr" >/dev/null 2>&1
    openssl x509 -req -sha256 -days 825 -in "$TLS_DIR/server.csr" \
      -CA "$TLS_CA" -CAkey "$TLS_DIR/local-ca.key" -CAcreateserial \
      -extfile "$ext" -out "$TLS_CERT" >/dev/null 2>&1
    rm -f -- "$ext" "$TLS_DIR/server.csr" "$TLS_DIR/local-ca.srl"
    # The CA private key is not needed after signing this server certificate.
    # Delete it so trusting the exported CA on a Windows PC cannot later be
    # abused by this host to mint additional trusted certificates.
    rm -f -- "$TLS_DIR/local-ca.key"
    chmod 0600 "$TLS_KEY"
    chmod 0644 "$TLS_CA" "$TLS_CERT"
  fi
  cat > "$TLS_SITE" <<EOF
# Linux Archive Explorer isolated local HTTPS endpoint.
# LAE owns the logging policy inside these dedicated virtual hosts only.
# Successful high-frequency LAE background/chunk requests are suppressed by
# the dontlog_app_polling_200 environment flag set in linux-archive-explorer.conf.
<VirtualHost *:80>
    ServerName $ip
    ServerAlias $host
    CustomLog \${APACHE_LOG_DIR}/access.log combined "expr=!(reqenv('dontlog_app_polling') == '1' || (reqenv('dontlog_app_polling_200') == '1' && %{REQUEST_STATUS} == 200))"
    RedirectMatch 302 ^/linux-archive-explorer/(.*)$ https://$ip/linux-archive-explorer/\$1
    Alias /linux-archive-explorer-local-ca.crt $TLS_CA
    <Directory $TLS_DIR>
        Require all denied
        <Files local-ca.crt>
            Require all granted
            ForceType application/x-x509-ca-cert
        </Files>
    </Directory>
</VirtualHost>

<VirtualHost *:443>
    ServerName $ip
    ServerAlias $host
    CustomLog \${APACHE_LOG_DIR}/access.log combined "expr=!(reqenv('dontlog_app_polling') == '1' || (reqenv('dontlog_app_polling_200') == '1' && %{REQUEST_STATUS} == 200))"
    SSLEngine on
    SSLCertificateFile $TLS_CERT
    SSLCertificateKeyFile $TLS_KEY
    Alias /linux-archive-explorer-local-ca.crt $TLS_CA
    <Directory $TLS_DIR>
        Require all denied
        <Files local-ca.crt>
            Require all granted
            ForceType application/x-x509-ca-cert
        </Files>
    </Directory>
</VirtualHost>
EOF
  chmod 0644 "$TLS_SITE"
  a2enmod ssl >/dev/null 2>&1
  a2ensite linux-archive-explorer-ssl >/dev/null 2>&1
  apache2ctl configtest >/dev/null 2>&1 || die 'Generated local HTTPS Apache configuration failed validation.'
  reload_apache
}


ensure_packages(){
  local packages=(apache2 apache2-utils php sudo tar gzip xz-utils zstd zip unzip python3 curl logrotate procps util-linux openssl)
  local missing=() p
  for p in "${packages[@]}"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p"); done
  # Accept either a working Apache PHP module or an existing PHP-FPM/proxy_fcgi setup.
  if ! apache2ctl -M 2>/dev/null | grep -Eq '(^|[[:space:]])php_module|proxy_fcgi_module'; then
    missing+=("libapache2-mod-php")
  fi
  if ((${#missing[@]})); then
    [[ "${LAE_SKIP_APT:-0}" != "1" ]] || die "Missing packages with LAE_SKIP_APT=1: ${missing[*]}"
    # A normal setup must not dump apt/dpkg progress to the terminal. Keep
    # diagnostic output only if installation fails, in a root-private log.
    local apt_log
    apt_log="$(mktemp /var/tmp/lae-dependencies.XXXXXXXX.log)"
    if ! apt-get -qq update >"$apt_log" 2>&1 ||
       ! DEBIAN_FRONTEND=noninteractive apt-get -qq -y install "${missing[@]}" >>"$apt_log" 2>&1; then
      die "Dependency installation failed. Details: $apt_log"
    fi
    rm -f -- "$apt_log"
  fi
  command -v php >/dev/null || die "php is unavailable."
  command -v apache2ctl >/dev/null || die "apache2ctl is unavailable."
  command -v visudo >/dev/null || die "visudo is unavailable."
  command -v python3 >/dev/null || die "python3 is unavailable."
  command -v tar >/dev/null || die "GNU tar is unavailable."
  command -v zip >/dev/null || die "zip is unavailable."
  command -v unzip >/dev/null || die "unzip is unavailable."
}

daily_logrotate_scheduler_available(){
  if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled --quiet logrotate.timer 2>/dev/null; then return 0; fi
  [[ -x /etc/cron.daily/logrotate ]]
}

validate_proxy_list(){
  local value="$1"
  [[ -z "$value" ]] && return 0
  python3 - "$value" <<'PYPROXY'
import ipaddress,sys
for raw in sys.argv[1].split(','):
    value=raw.strip()
    if not value: raise SystemExit(1)
    ipaddress.ip_address(value)
PYPROXY
}

prompt_deployment(){
  local deployment="${LAE_DEPLOYMENT:-}"
  local proxies="${LAE_TRUSTED_PROXIES:-}"
  [[ -n "$deployment" ]] || deployment=lan
  [[ "$deployment" == "lan" || "$deployment" == "public" ]] || die "LAE_DEPLOYMENT must be lan or public."
  if [[ "$deployment" == "public" ]]; then
    local local_https=0
    apache2ctl -M 2>/dev/null | grep -q ssl_module && apache2ctl -S 2>&1 | grep -q ':443' && local_https=1 || true
    if [[ $local_https -eq 0 && -z "$proxies" ]]; then
      if [[ -t 0 ]]; then
        printf '\nPublic/cloud installations must use HTTPS. If HTTPS terminates at a trusted reverse proxy, enter only its source IP address(es), comma separated.\n'
        read -r -p 'Trusted reverse proxy IP(s), or leave blank if Apache itself already serves HTTPS: ' proxies
      fi
    fi
    if [[ $local_https -eq 0 && -z "$proxies" ]]; then
      die "Public/cloud mode requires Apache HTTPS or explicitly configured trusted HTTPS reverse proxy IP(s). No files were changed."
    fi
  fi
  validate_proxy_list "$proxies" || die "Trusted reverse proxies must be literal IPv4/IPv6 addresses, comma separated."
  LAE_DEPLOYMENT_SELECTED="$deployment"
  LAE_TRUSTED_PROXIES_SELECTED="$proxies"
}

hash_password(){
  local pw="$1"
  printf '%s' "$pw" | php -r '$p=stream_get_contents(STDIN); if (defined("PASSWORD_ARGON2ID")) echo password_hash($p, PASSWORD_ARGON2ID); else echo password_hash($p, PASSWORD_BCRYPT,["cost"=>12]);'
}

ini_escape(){ printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

prompt_credentials(){
  local user="${LAE_ADMIN_USER:-admin}" pass="${LAE_ADMIN_PASSWORD:-}" confirm=""
  printf '\nCreate the Administrator account used to sign in to Linux Archive Explorer in your web browser.\n'
  if [[ -t 0 && -z "${LAE_ADMIN_USER:-}" ]]; then read -r -p 'Login username [admin]: ' v; [[ -n "$v" ]] && user="$v"; fi
  [[ "$user" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "Username may contain letters, numbers, dot, underscore and dash only."
  if [[ -z "$pass" ]]; then
    [[ -t 0 ]] || die "Set LAE_ADMIN_PASSWORD for non-interactive first installation."
    while :; do
      read -r -s -p 'Login password (minimum 8 characters): ' pass; echo
      read -r -s -p 'Confirm password: ' confirm; echo
      [[ "$pass" == "$confirm" ]] || { warn "Passwords do not match."; continue; }
      ((${#pass} >= 8)) || { warn "Password must be at least 8 characters."; continue; }
      break
    done
  fi
  ((${#pass} >= 8)) || die "Password must be at least 8 characters."
  LAE_ADMIN_USER_SELECTED="$user"
  LAE_ADMIN_HASH_SELECTED="$(hash_password "$pass")"
  unset pass confirm LAE_ADMIN_PASSWORD
}

make_persistent_dirs(){
  mkdir -p "$APP_ROOT" "$CONFIG_DIR" "$DATA" "$DATA_RUNTIME" "$JOBS" "$STAGING" "$UPLOADS" "$ARCHIVES" "$ROLLBACK/installer" "$ROLLBACK/restore" "$ROLLBACK/trash" "$LOGS/app" "$LOGS/audit" "$RECOVERY"
  chown root:root "$APP_ROOT" "$ROLLBACK" "$ROLLBACK/installer" "$ROLLBACK/restore" "$ROLLBACK/trash" "$LOGS" "$LOGS/audit" "$RECOVERY"
  chmod 0755 "$APP_ROOT" "$LOGS"; chmod 0700 "$ROLLBACK" "$ROLLBACK/installer" "$ROLLBACK/restore" "$ROLLBACK/trash" "$LOGS/audit" "$RECOVERY"
  chown root:www-data "$CONFIG_DIR" "$DATA" "$DATA_RUNTIME" "$JOBS" "$STAGING" "$ARCHIVES" "$UPLOADS" "$LOGS/app"
  chmod 0750 "$CONFIG_DIR" "$DATA" "$STAGING" "$ARCHIVES" "$JOBS"
  # GNU chmod preserves setgid on directories in some numeric-mode cases.
  # Clear legacy setgid permissions on data/; only the runtime child is group-writable.
  chmod g-s "$DATA"
  chmod 2770 "$DATA_RUNTIME" "$UPLOADS" "$LOGS/app"
}

write_new_config(){
  [[ -f "$SOURCE_DIR/config.ini.example" ]] || die "Package missing config.ini.example"
  # The template is authoritative. Substitute only installation-dependent values;
  # all other documented defaults come from config.ini.example.
  python3 - "$SOURCE_DIR/config.ini.example" "$CONFIG" "$VERSION" "$BASE_URL" "$APP_ROOT" "$DATA" "$JOBS" "$STAGING" "$UPLOADS" "$ARCHIVES" "$ROLLBACK" "$LOGS" "$RECOVERY" "$ARCHIVE_HELPER" "$RESTORE_HELPER" "$LAE_DEPLOYMENT_SELECTED" "$LAE_TRUSTED_PROXIES_SELECTED" <<'PYINITCFG'
import configparser,grp,os,sys,tempfile
(template,path,version,base,root,data,jobs,staging,uploads,archives,rollback,logs,recovery,archive_helper,restore_helper,deployment,proxies)=sys.argv[1:]
cp=configparser.ConfigParser(interpolation=None)
if not cp.read(template,encoding='utf-8'):raise SystemExit('Cannot read config.ini.example')
updates={
 'application':{'version':version,'base_url':base},
 'paths':{'root':root,'data':data,'jobs':jobs,'staging':staging,'uploads':uploads,'archives':archives,'rollback':rollback,'logs':logs,'recovery':recovery},
 'system':{'archive_helper':archive_helper,'restore_helper':restore_helper,'deployment':deployment,'trusted_proxies':proxies},
}
for section, values in updates.items():
 if not cp.has_section(section):raise SystemExit('Missing template section: '+section)
 for key,value in values.items():
  # Release identity comes only from VERSION. The template intentionally does
  # not carry a second version number that must be bumped for every release.
  if key != 'version' and not cp.has_option(section,key):raise SystemExit('Missing template key: '+section+'.'+key)
  cp.set(section,key,value)
fd,tmp=tempfile.mkstemp(prefix='.new-config-',dir=os.path.dirname(path))
try:
 with os.fdopen(fd,'w',encoding='utf-8') as file:
  cp.write(file);file.flush();os.fsync(file.fileno())
 os.chown(tmp,0,grp.getgrnam('www-data').gr_gid);os.chmod(tmp,0o640);os.replace(tmp,path)
finally:
 try:os.unlink(tmp)
 except FileNotFoundError:pass
PYINITCFG
  chown root:www-data "$CONFIG"; chmod 0640 "$CONFIG"
}

write_initial_users_db(){
  python3 - "$USERS_DB" "$LAE_ADMIN_USER_SELECTED" "$LAE_ADMIN_HASH_SELECTED" <<'PYUSERS'
import grp,json,os,sys,tempfile,time
path,user,pwhash=sys.argv[1:]
data={"schema":1,"users":[{"username":user,"password_hash":pwhash,"role":"admin","enabled":True,"created_at":int(time.time())}]}
os.makedirs(os.path.dirname(path),exist_ok=True)
fd,tmp=tempfile.mkstemp(prefix='.users-',dir=os.path.dirname(path))
try:
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        json.dump(data,f,ensure_ascii=False,separators=(',',':'));f.write('\n');f.flush();os.fsync(f.fileno())
    os.chown(tmp,0,grp.getgrnam('www-data').gr_gid);os.chmod(tmp,0o640);os.replace(tmp,path)
finally:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
PYUSERS
}

migrate_users_db(){
  if [[ -f "$USERS_DB" ]]; then
    python3 - "$USERS_DB" <<'PYUSERSCHECK'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f:data=json.load(f)
users=data.get('users') if isinstance(data,dict) else None
if not isinstance(users,list) or not any(isinstance(u,dict) and u.get('role')=='admin' and u.get('enabled',True) for u in users):
    raise SystemExit('Existing user database has no enabled Administrator; restore an account or use the documented password recovery procedure before updating.')
PYUSERSCHECK
    chown root:www-data "$USERS_DB"; chmod 0640 "$USERS_DB"
    return
  fi
  local old_user old_hash
  old_user="$(php -r '$c=parse_ini_file($argv[1],true,INI_SCANNER_TYPED); echo $c["auth"]["username"]??"admin";' "$CONFIG")"
  old_hash="$(php -r '$c=parse_ini_file($argv[1],true,INI_SCANNER_TYPED); echo $c["auth"]["password_hash"]??"";' "$CONFIG")"
  [[ "$old_user" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "Existing login username is invalid; cannot migrate user database safely."
  [[ -n "$old_hash" ]] || die "Existing login password hash is missing; cannot migrate user database safely."
  LAE_ADMIN_USER_SELECTED="$old_user"; LAE_ADMIN_HASH_SELECTED="$old_hash"
  write_initial_users_db
  ok "Migrated existing administrator account to protected multi-user database"
}

migrate_config(){
  [[ -f "$CONFIG" ]] || die "Existing installation is missing config.ini. Use --repair only after restoring the configuration backup."
  python3 - "$CONFIG" "$VERSION" "$BASE_URL" "$APP_ROOT" "$DATA" "$JOBS" "$STAGING" "$UPLOADS" "$ARCHIVES" "$ROLLBACK" "$LOGS" "$RECOVERY" "$ARCHIVE_HELPER" "$RESTORE_HELPER" "$LAE_DEPLOYMENT_SELECTED" "$LAE_TRUSTED_PROXIES_SELECTED" <<'PYCFG'
import configparser,grp,os,sys,tempfile
(path,version,base,root,data,jobs,staging,uploads,archives,rollback,logs,recovery,archive_helper,restore_helper,deployment,proxies)=sys.argv[1:]
cp=configparser.ConfigParser(interpolation=None)
cp.read(path,encoding='utf-8')
updates={
 'application': {'version':version,'base_url':base,'session_timeout':cp.get('application','session_timeout',fallback='1800'),'default_format':cp.get('application','default_format',fallback='tar.gz')},
 'paths': {'root':root,'data':data,'jobs':jobs,'staging':staging,'uploads':uploads,'archives':archives,'rollback':rollback,'logs':logs,'recovery':recovery},
 'system': {'archive_helper':archive_helper,'restore_helper':restore_helper,'use_sudo':'true','deployment':deployment,'trusted_proxies':proxies,'web_group':'www-data'},
 'logging': {'max_bytes':'5242880','backups':'2','rotate_daily':'true','compress':'false'},
 'limits': {'upload_max_bytes':cp.get('limits','upload_max_bytes',fallback='268435456'),'upload_chunk_bytes':cp.get('limits','upload_chunk_bytes',fallback='8388608')},
 'updates': {'version_url':cp.get('updates','version_url',fallback='') or 'https://raw.githubusercontent.com/TerryClaiborne/linux-archive-explorer/main/VERSION','release_url':cp.get('updates','release_url',fallback='') or 'https://github.com/TerryClaiborne/linux-archive-explorer'},
}
# Updating README or another unchanged file must not rewrite private config.ini.
# Compare logical values, tolerating the quotes used in older template files.
changed = False
def normalized(value):
    value=value.strip()
    return value[1:-1] if len(value)>=2 and value[0]==value[-1] and value[0] in ('"', "'") else value
for section,values in updates.items():
    if not cp.has_section(section):cp.add_section(section);changed=True
    for key,value in values.items():
        if not cp.has_option(section,key) or normalized(cp.get(section,key))!=str(value):
            cp.set(section,key,str(value));changed=True
if not cp.has_section('auth'):cp.add_section('auth');changed=True
for key in ('username','password_hash'):
    if cp.remove_option('auth',key):changed=True
if not cp.has_option('auth','auth_bypass') or normalized(cp.get('auth','auth_bypass')).lower()!='false':
    cp.set('auth','auth_bypass','false');changed=True
if not changed:
    raise SystemExit(0)
fd,tmp=tempfile.mkstemp(prefix='.config-',dir=os.path.dirname(path))
try:
    # Preserve administrator comments, spacing and untouched settings.  The
    # configparser serialization used previously erased every comment on update.
    import re
    original=open(path,encoding='utf-8').read()
    lines=original.splitlines(keepends=True)
    section=None; seen=set(); result=[]
    sec_re=re.compile(r'^\s*\[([^]]+)\]\s*(?:[;#].*)?$')
    key_re=re.compile(r'^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(=|:)\s*(.*?)(\r?\n)?$')
    def add_missing(sec):
        if sec is None:return
        for key in cp[sec]:
            if (sec,key) not in seen:
                result.append(f'{key} = {cp[sec][key]}\n')
                seen.add((sec,key))
    for line in lines:
        m=sec_re.match(line.rstrip('\r\n'))
        if m:
            add_missing(section)
            section=m.group(1).lower()
            result.append(line)
            continue
        m=key_re.match(line)
        if m and section is not None and not line.lstrip().startswith(('#',';')):
            key=m.group(2).lower()
            if key in cp[section]:
                seen.add((section,key))
                old_value=normalized(m.group(4).strip())
                new_value=cp[section][key]
                if old_value!=new_value:
                    newline = "\r\n" if line.endswith("\r\n") else ("\n" if line.endswith("\n") else "")
                    line=f'{m.group(1)}{m.group(2)} {m.group(3)} {new_value}{newline}'
            else:
                # Strip retired auth secrets only; don't strip custom keys.
                if section=='auth' and key in ('username','password_hash'):continue
        result.append(line)
    add_missing(section)
    for sec in cp.sections():
        if sec not in {x[0] for x in seen}:
            if result and not result[-1].endswith('\n'):result[-1]+='\n'
            result.append(f'\n[{sec}]\n')
            for key in cp[sec]: result.append(f'{key} = {cp[sec][key]}\n')
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        f.write(''.join(result)); f.flush(); os.fsync(f.fileno())
    os.chown(tmp,0,grp.getgrnam('www-data').gr_gid); os.chmod(tmp,0o640); os.replace(tmp,path)
finally:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
PYCFG
  chown root:www-data "$CONFIG"; chmod 0640 "$CONFIG"
}

installer_free_space_preflight(){
  # Reserve sufficient free space on small and large installations.
  python3 - "$APP_ROOT" "$CURRENT" "$DATA" "$RECOVERY" <<'PYSPACE'
import os,shutil,sys
root,current,data,recovery=sys.argv[1:]
existing=next((p for p in (root,os.path.dirname(root),'/') if os.path.isdir(p)),'/')
usage=shutil.disk_usage(existing)
reserve=max(512*1024*1024,usage.total//10)
required=16*1024*1024
for path in (current,data,recovery):
 if not os.path.isdir(path):continue
 for base,dirs,files in os.walk(path,followlinks=False):
  dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(base,d))]
  for name in files:
   try:required+=os.lstat(os.path.join(base,name)).st_size
   except OSError:pass
if usage.free < reserve + required:
 raise SystemExit('STOP: insufficient space for a verified installer rollback while keeping 512 MiB or 10% disk reserve')
pass  # quiet on successful free-space check; failures still abort
PYSPACE
}

create_protected_backup(){
  local items=()
  [[ -d "$CURRENT" ]] && items+=("${CURRENT#/}")
  [[ -f "$CONFIG" ]] && items+=("${CONFIG#/}")
  [[ -d "$CONFIG_DIR" ]] && items+=("${CONFIG_DIR#/}")
  [[ -d "$DATA" ]] && items+=("${DATA#/}")
  [[ -f "$APACHE_CONF" ]] && items+=("${APACHE_CONF#/}")
  [[ -f "$TLS_SITE" ]] && items+=("${TLS_SITE#/}")
  [[ -f "$SUDOERS" ]] && items+=("${SUDOERS#/}")
  [[ -f "$LOGROTATE_CONF" ]] && items+=("${LOGROTATE_CONF#/}")
  [[ -f "$SYSTEMD_SERVICE" ]] && items+=("${SYSTEMD_SERVICE#/}")
  [[ -f "$CLEANUP_SERVICE" ]] && items+=("${CLEANUP_SERVICE#/}")
  [[ -f "$CLEANUP_TIMER" ]] && items+=("${CLEANUP_TIMER#/}")
  [[ -d "$RECOVERY" ]] && items+=("${RECOVERY#/}")
  ((${#items[@]})) || return 0
  local prior_version="unknown"
  if [[ -f "$CURRENT/VERSION" ]]; then
    prior_version="$(tr -d '[:space:]' < "$CURRENT/VERSION")"
    [[ "$prior_version" =~ ^[0-9A-Za-z._-]+$ ]] || prior_version="unknown"
  fi
  BACKUP_TAR="$ROLLBACK/installer/setup-before-v${prior_version}-${STAMP}.tar.gz"
  say "Saving one verified pre-update recovery point"
  tar --create --gzip --acls --xattrs --numeric-owner --file="$BACKUP_TAR" --directory=/ "${items[@]}"
  sha256sum "$BACKUP_TAR" > "$BACKUP_TAR.sha256"
  chmod 0600 "$BACKUP_TAR" "$BACKUP_TAR.sha256"; chown root:root "$BACKUP_TAR" "$BACKUP_TAR.sha256"
  sha256sum -c "$BACKUP_TAR.sha256" >/dev/null || die "Rollback archive verification failed."
}

stage_release(){
  local stage="$APP_ROOT/.release-new.$$"
  rm -rf "$stage"; mkdir -p "$stage"
  # Do not wrap the producer in a parenthesized Bash subshell: the installer
  # has an EXIT trap, and a child shell must never be able to run cleanup on
  # the parent's staging directory.  GNU tar's --directory gives us the same
  # source-relative archive without a shell subshell.
  # Whitelist only deployed runtime/docs. Never copy .git, tests, old build artifacts, secrets or development files.
  local runtime_items=(app bin public README.md LICENSE SECURITY.md VERSION config.ini.example setup_linux_archive_explorer.sh)
  for item in "${runtime_items[@]}"; do [[ -e "$SOURCE_DIR/$item" ]] || die "Release is missing $item"; done
  tar --create --file=- --directory="$SOURCE_DIR" --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' "${runtime_items[@]}" | tar --extract --file=- --directory="$stage"
  find "$stage" -type d -exec chmod 0755 {} +
  find "$stage" -type f -exec chmod 0644 {} +
  chmod 0755 "$stage/bin/archive-helper.py" "$stage/bin/restore-helper.py" "$stage/bin/storage-maintenance.py" "$stage/bin/common.py" "$stage/setup_linux_archive_explorer.sh" 2>/dev/null || true
  chown -R root:root "$stage"
  find "$stage/app" "$stage/public" -name '*.php' -print0 | xargs -0 -n1 php -l >/dev/null
  python3 -m py_compile "$stage/bin/common.py" "$stage/bin/archive-helper.py" "$stage/bin/restore-helper.py"
  if command -v node >/dev/null 2>&1; then
    node --check "$stage/public/assets/app.js" >/dev/null || die "Staged JavaScript syntax check failed."
  fi
  rm -rf "$stage/bin/__pycache__"
}

build_integration_files(){
  TMP_SUDOERS="$(mktemp /etc/sudoers.d/.linux-archive-explorer.XXXXXX)"
  cat > "$TMP_SUDOERS" <<EOF
# Linux Archive Explorer - installed and owned by setup_linux_archive_explorer.sh
# The web user may execute only these root-owned helpers, with NO command-line arguments.
www-data ALL=(root) NOPASSWD: $ARCHIVE_HELPER ""
www-data ALL=(root) NOPASSWD: $RESTORE_HELPER ""
EOF
  chown root:root "$TMP_SUDOERS"; chmod 0440 "$TMP_SUDOERS"
  visudo -cf "$TMP_SUDOERS" >/dev/null || die "Staged sudoers policy failed validation."

  TMP_LOGROTATE="$(mktemp /etc/logrotate.d/.linux-archive-explorer.XXXXXX)"
  cat > "$TMP_LOGROTATE" <<EOF
# Linux Archive Explorer - rotates ONLY application-owned logs.
$LOGS/audit/audit.log {
    daily
    maxsize 5M
    rotate 2
    nocompress
    missingok
    notifempty
    su root root
    create 0640 root root
}

$LOGS/app/app-error.log {
    daily
    maxsize 5M
    rotate 2
    nocompress
    missingok
    notifempty
    su root www-data
    create 0660 root www-data
}
EOF
  chown root:root "$TMP_LOGROTATE"; chmod 0644 "$TMP_LOGROTATE"
  /usr/sbin/logrotate --debug "$TMP_LOGROTATE" >/dev/null 2>&1 || die "Staged logrotate policy failed validation."

  TMP_SYSTEMD="$(mktemp /etc/systemd/system/.linux-archive-explorer-recovery.XXXXXX)"
  cat > "$TMP_SYSTEMD" <<EOF
[Unit]
Description=Linux Archive Explorer interrupted restore recovery
Documentation=file://$CURRENT/README.md
After=local-fs.target
Before=apache2.service
ConditionPathExists=$JOBS

[Service]
Type=oneshot
User=root
Group=root
Environment=LAE_CONFIG=$RECOVERY_CONFIG
Environment=LAE_RECOVERY_BOOT=1
ExecStart=/usr/bin/python3 $RECOVERY/restore-helper.py --recover
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  chown root:root "$TMP_SYSTEMD"; chmod 0644 "$TMP_SYSTEMD"

  TMP_CLEANUP_SERVICE="$(mktemp /etc/systemd/system/.linux-archive-explorer-cleanup-service.XXXXXX)"
  cat > "$TMP_CLEANUP_SERVICE" <<EOF
[Unit]
Description=Linux Archive Explorer clean abandoned temporary files
ConditionPathExists=$CONFIG

[Service]
Type=oneshot
User=root
Group=root
Environment=LAE_CONFIG=$CONFIG
ExecStart=/usr/bin/python3 $CURRENT/bin/archive-helper.py --cleanup
UMask=0077
EOF
  TMP_CLEANUP_TIMER="$(mktemp /etc/systemd/system/.linux-archive-explorer-cleanup-timer.XXXXXX)"
  cat > "$TMP_CLEANUP_TIMER" <<'EOF'
[Unit]
Description=Linux Archive Explorer abandoned staging cleanup timer

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
Persistent=true
Unit=linux-archive-explorer-cleanup.service

[Install]
WantedBy=timers.target
EOF
  chown root:root "$TMP_CLEANUP_SERVICE" "$TMP_CLEANUP_TIMER"
  chmod 0644 "$TMP_CLEANUP_SERVICE" "$TMP_CLEANUP_TIMER"

  TMP_APACHE="$(mktemp /etc/apache2/conf-available/.linux-archive-explorer.XXXXXX)"
  cat > "$TMP_APACHE" <<EOF
# Linux Archive Explorer - isolated Apache integration.
# These rules only tag LAE's own successful high-frequency background/chunk
# requests. Existing site logging filters are not modified or replaced.
# The dedicated LAE local-HTTPS virtual hosts honor this flag directly; an
# existing host that already honors dontlog_app_polling_200 will do so too.
SetEnvIf Request_URI "^/linux-archive-explorer/api/(status|events)\.php$" dontlog_app_polling_200=1
SetEnvIfExpr "%{REQUEST_URI} == '/linux-archive-explorer/api/upload.php' && %{QUERY_STRING} =~ m#(^|&)action=chunk(&|$)#" dontlog_app_polling_200=1
SetEnvIfExpr "%{REQUEST_URI} == '/linux-archive-explorer/api/transfer.php' && %{QUERY_STRING} =~ m#(^|&)action=chunk(&|$)#" dontlog_app_polling_200=1

RedirectMatch 302 ^/linux-archive-explorer$ /linux-archive-explorer/
Alias /linux-archive-explorer/ $CURRENT/public/

<Directory $APP_ROOT>
    Require all denied
</Directory>

<Directory $CURRENT/public>
    Options -Indexes -FollowSymLinks
    AllowOverride None
    DirectoryIndex index.php
    Require all granted

    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "DENY"
    Header always set Referrer-Policy "same-origin"
    Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
</Directory>
EOF
  chown root:root "$TMP_APACHE"; chmod 0644 "$TMP_APACHE"
}

activate_release(){
  local stage="$APP_ROOT/.release-new.$$"
  MODIFIED=1
  if [[ -d "$CURRENT" ]]; then OLD_CURRENT="$APP_ROOT/.current-old.$$"; rm -rf "$OLD_CURRENT"; mv "$CURRENT" "$OLD_CURRENT"; fi
  mv "$stage" "$CURRENT"
  mkdir -p "$RECOVERY"
  install -o root -g root -m 0700 "$CURRENT/bin/restore-helper.py" "$RECOVERY/restore-helper.py"
  install -o root -g root -m 0600 "$CURRENT/bin/common.py" "$RECOVERY/common.py"
  cat > "$RECOVERY_CONFIG" <<EOF
[application]
version = "$VERSION"
[paths]
root = "$APP_ROOT"
jobs = "$JOBS"
staging = "$STAGING"
uploads = "$UPLOADS"
archives = "$ARCHIVES"
rollback = "$ROLLBACK"
logs = "$LOGS"
[system]
web_group = "www-data"
[logging]
max_bytes = 5242880
backups = 2
EOF
  chown root:root "$RECOVERY_CONFIG"; chmod 0600 "$RECOVERY_CONFIG"
  install -o root -g root -m 0440 "$TMP_SUDOERS" "$SUDOERS"
  install -o root -g root -m 0644 "$TMP_LOGROTATE" "$LOGROTATE_CONF"
  install -o root -g root -m 0644 "$TMP_APACHE" "$APACHE_CONF"
  install -o root -g root -m 0644 "$TMP_SYSTEMD" "$SYSTEMD_SERVICE"
  install -o root -g root -m 0644 "$TMP_CLEANUP_SERVICE" "$CLEANUP_SERVICE"
  install -o root -g root -m 0644 "$TMP_CLEANUP_TIMER" "$CLEANUP_TIMER"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl daemon-reload
    systemctl enable linux-archive-explorer-recovery.service >/dev/null 2>&1
    systemctl enable --now linux-archive-explorer-cleanup.timer >/dev/null 2>&1
  fi
  a2enmod headers >/dev/null 2>&1
  a2enconf linux-archive-explorer >/dev/null 2>&1
  apache2ctl configtest >/dev/null 2>&1 || die "Apache configuration validation failed. Run apache2ctl configtest for details."
  reload_apache
}

verify_installation(){
  local failures=0
  printf '\n===== LINUX ARCHIVE EXPLORER VERIFY =====\n'
  verify_ok(){ printf '[OK]   %s\n' "$*"; }
  verify_bad(){ printf '[FAIL] %s\n' "$*"; failures=$((failures+1)); }
  [[ -d "$CURRENT/public" ]] && verify_ok "Application release is installed" || verify_bad "Application release is missing"
  if [[ -f "$CURRENT/README.md" && -f "$CURRENT/config.ini.example" && -f "$CURRENT/VERSION" ]]; then
    verify_ok "Internal README, config.ini.example and VERSION are installed"
  else
    verify_bad "Internal documentation, example configuration or VERSION is missing"
  fi
  if [[ ! -e "$CURRENT/docs" && ! -e "$CURRENT/tests" && ! -e "$CURRENT/.git" && ! -e "$CURRENT/SHA256SUMS" ]]; then
    verify_ok "Runtime release excludes development docs, tests, Git metadata and package checksums"
  else
    verify_bad "Development material was unexpectedly installed in runtime release"
  fi
  [[ -f "$CONFIG" ]] && verify_ok "config.ini exists outside the public directory" || verify_bad "config.ini is missing"
  [[ "$(stat -c '%U:%G %a' "$CONFIG" 2>/dev/null)" == "root:www-data 640" ]] && verify_ok "config.ini ownership/mode root:www-data 0640" || verify_bad "config.ini ownership/mode is wrong"
  runuser -u www-data -- test -r "$CONFIG" && verify_ok "www-data can read config.ini" || verify_bad "www-data cannot read config.ini"
  if runuser -u www-data -- test -w "$CONFIG"; then verify_bad "www-data can WRITE config.ini"; else verify_ok "www-data cannot write config.ini"; fi
  [[ "$(stat -c '%U:%G' "$ARCHIVE_HELPER" 2>/dev/null)" == "root:root" ]] && verify_ok "Archive helper is root-owned" || verify_bad "Archive helper ownership is wrong"
  [[ "$(stat -c '%U:%G' "$RESTORE_HELPER" 2>/dev/null)" == "root:root" ]] && verify_ok "Restore helper is root-owned" || verify_bad "Restore helper ownership is wrong"
  [[ "$(stat -c '%U:%G %a' "$RECOVERY/restore-helper.py" 2>/dev/null)" == "root:root 700" ]] && verify_ok "Boot recovery helper is accessible only by the Linux root account" || verify_bad "Boot recovery helper permissions are wrong"
  [[ "$(stat -c '%U:%G %a' "$RECOVERY_CONFIG" 2>/dev/null)" == "root:root 600" ]] && verify_ok "Boot recovery configuration is accessible only by the Linux root account" || verify_bad "Boot recovery configuration permissions are wrong"
  [[ -f "$SYSTEMD_SERVICE" ]] && verify_ok "Interrupted-restore recovery service is installed" || verify_bad "Interrupted-restore recovery service is missing"
  [[ -f "$CLEANUP_SERVICE" && -f "$CLEANUP_TIMER" ]] && verify_ok "Abandoned staging cleanup timer installed" || verify_bad "Abandoned staging cleanup timer missing"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl is-enabled --quiet linux-archive-explorer-recovery.service && verify_ok "Interrupted-restore recovery service is enabled" || verify_bad "Interrupted-restore recovery service is not enabled"
    systemctl is-enabled --quiet linux-archive-explorer-cleanup.timer && verify_ok "Abandoned staging cleanup timer enabled" || verify_bad "Abandoned staging cleanup timer disabled"
  else
    verify_ok "Recovery service enablement deferred (systemd is not PID 1 in this test environment)"
  fi
  if find "$CURRENT" -xdev -perm -0002 -print -quit | grep -q .; then verify_bad "World-writable files exist in current release"; else verify_ok "Current release has no world-writable files"; fi
  if id -nG www-data 2>/dev/null | tr ' ' '\n' | grep -qx sudo; then verify_bad "www-data is a member of sudo group"; else verify_ok "www-data is not a sudo-group member"; fi
  visudo -cf "$SUDOERS" >/dev/null 2>&1 && verify_ok "Linux Archive Explorer sudoers syntax is valid" || verify_bad "Linux Archive Explorer sudoers syntax failed"
  apache2ctl configtest >/dev/null 2>&1 && verify_ok "Apache configuration test passed" || verify_bad "Apache configuration test failed"
  if [[ -f "$LOGROTATE_CONF" ]] && /usr/sbin/logrotate --debug "$LOGROTATE_CONF" >/dev/null 2>&1; then verify_ok "Dedicated daily logrotate policy is valid"; else verify_bad "Dedicated logrotate policy is missing or invalid"; fi
  if daily_logrotate_scheduler_available; then verify_ok "Daily logrotate scheduler is enabled"; else verify_bad "No enabled daily logrotate scheduler was found"; fi
  if grep -Eq '^/var/www/linux-archive-explorer/logs/(audit/audit|app/app-error)\.log \{' "$LOGROTATE_CONF" 2>/dev/null && ! grep -Ev '^[[:space:]]*(#.*|$|/var/www/linux-archive-explorer/logs/(audit/audit|app/app-error)\.log \{|daily|maxsize 5M|rotate 2|nocompress|missingok|notifempty|su root (root|www-data)|create (0640 root root|0660 root www-data)|\})[[:space:]]*$' "$LOGROTATE_CONF" | grep -q .; then verify_ok "Logrotate policy references only Linux Archive Explorer logs"; else verify_bad "Logrotate policy contains unexpected paths/directives"; fi
  local request='{"action":"list-dir","path":"/","dirs_only":true}'
  if printf '%s' "$request" | runuser -u www-data -- sudo -n "$ARCHIVE_HELPER" >/dev/null 2>&1; then verify_ok "www-data can invoke the archive helper through the exact approved path"; else verify_bad "Approved archive helper sudo path failed"; fi
  if printf '%s' "$request" | runuser -u www-data -- sudo -n "$ARCHIVE_HELPER" extra >/dev/null 2>&1; then verify_bad "Archive helper accepted unauthorized command-line arguments through sudo"; else verify_ok "sudoers rejects helper command-line arguments"; fi
  if printf '%s' '{"action":"history"}' | runuser -u www-data -- sudo -n "$RESTORE_HELPER" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") and isinstance(d.get("history"),list)' >/dev/null 2>&1; then
    verify_ok "Privileged Restore History access is functional"
  else
    verify_bad "Privileged Restore History helper failed"
  fi
  if runuser -u www-data -- sudo -n /bin/true >/dev/null 2>&1; then verify_bad "www-data has unexpected arbitrary sudo access"; else verify_ok "www-data does not have arbitrary sudo access"; fi
  local audit_out audit_rc=0
  audit_out="$(printf '%s' '{"action":"log-event","event":"security.verify","details":{"source":"installer"}}' | runuser -u www-data -- sudo -n "$ARCHIVE_HELPER" 2>&1)" || audit_rc=$?
  if [[ $audit_rc -eq 0 && -f "$LOGS/audit/audit.log" ]]; then verify_ok "Dedicated audit log is writable through the privileged root helper"; else verify_bad "Dedicated audit log test failed (helper rc=$audit_rc: ${audit_out:-no output})"; fi
  [[ "$(stat -c '%U:%G %a' "$LOGS/audit" 2>/dev/null)" == "root:root 700" ]] && verify_ok "Audit log directory is accessible only by the Linux root account" || verify_bad "Audit log directory permissions are wrong"
  if runuser -u www-data -- test -w "$LOGS/audit"; then verify_bad "www-data can write/delete privileged audit logs"; else verify_ok "www-data cannot write/delete privileged audit logs"; fi
  runuser -u www-data -- test -w "$LOGS/app" && verify_ok "PHP application-error log directory is writable by www-data" || verify_bad "PHP application-error log directory is not writable"
  local data_mode
  data_mode="$(stat -c '%U:%G %a' "$DATA" 2>/dev/null || true)"
  [[ "$data_mode" == "root:www-data 750" ]] && verify_ok "Protected data directory permissions are correct" || verify_bad "Protected data directory permissions are wrong (found: ${data_mode:-missing})"
  [[ "$(stat -c '%U:%G %a' "$DATA_RUNTIME" 2>/dev/null)" == "root:www-data 2770" ]] && verify_ok "Writable runtime-state directory permissions are correct" || verify_bad "Runtime-state directory permissions are wrong"
  [[ "$(stat -c '%U:%G %a' "$USERS_DB" 2>/dev/null)" == "root:www-data 640" ]] && verify_ok "Multi-user database ownership/mode root:www-data 0640" || verify_bad "Multi-user database permissions are wrong"
  if runuser -u www-data -- test -w "$USERS_DB"; then verify_bad "www-data can WRITE the multi-user database"; else verify_ok "www-data cannot write the multi-user database"; fi
  if python3 - "$USERS_DB" <<'PYUSERVERIFY' >/dev/null 2>&1
import json,sys
with open(sys.argv[1],encoding='utf-8') as f:d=json.load(f)
u=d.get('users') if isinstance(d,dict) else None
assert isinstance(u,list) and any(isinstance(x,dict) and x.get('role')=='admin' and x.get('enabled',True) for x in u)
PYUSERVERIFY
  then verify_ok "At least one enabled administrator account exists"; else verify_bad "User database is invalid or has no enabled administrator"; fi
  [[ "$(stat -c '%U:%G %a' "$JOBS" 2>/dev/null)" == "root:www-data 750" ]] && verify_ok "Job directory permissions are correct" || verify_bad "Job directory permissions are wrong"
  [[ "$(stat -c '%U:%G %a' "$UPLOADS" 2>/dev/null)" == "root:www-data 2770" ]] && verify_ok "Upload staging permissions are correct" || verify_bad "Upload staging permissions are wrong"
  [[ "$(stat -c '%U:%G %a' "$STAGING" 2>/dev/null)" == "root:www-data 750" ]] && verify_ok "Archive staging permissions are correct" || verify_bad "Archive staging permissions are wrong"
  [[ "$(stat -c '%U:%G %a' "$ARCHIVES" 2>/dev/null)" == "root:www-data 750" ]] && verify_ok "Archive storage permissions are correct" || verify_bad "Archive storage permissions are wrong"
  [[ "$(stat -c '%U:%G %a' "$ROLLBACK" 2>/dev/null)" == "root:root 700" ]] && verify_ok "Rollback storage is accessible only by the Linux root account" || verify_bad "Rollback storage permissions are wrong"
  [[ ! -e "$APP_ROOT/current/config/config.ini" && ! -e "$APP_ROOT/current/config.ini" ]] && verify_ok "No credential file exists under the public release tree" || verify_bad "Credential file unexpectedly exists under current release"
  find "$CURRENT/app" "$CURRENT/public" -name '*.php' -print0 | xargs -0 -n1 php -l >/dev/null 2>&1 && verify_ok "PHP syntax validation passed" || verify_bad "PHP syntax validation failed"
  python3 -m py_compile "$CURRENT/bin/common.py" "$CURRENT/bin/archive-helper.py" "$CURRENT/bin/restore-helper.py" >/dev/null 2>&1 && verify_ok "Privileged helper compilation test passed" || verify_bad "Privileged helper compilation test failed"
  command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1 && verify_ok "ZIP create/view/restore dependencies are installed" || verify_bad "ZIP dependencies are missing"
  rm -rf "$CURRENT/bin/__pycache__" 2>/dev/null || true
  if LAE_CONFIG="$RECOVERY_CONFIG" LAE_RECOVERY_BOOT=1 /usr/bin/python3 "$RECOVERY/restore-helper.py" --recover >/dev/null 2>&1; then verify_ok "Boot recovery helper self-test passed"; else verify_bad "Boot recovery helper self-test failed"; fi
  # Verify actual PHP execution, not merely a reachable Apache listener.
  # Strict policy: a 200 with this release's own header is healthy; public
  # deployments may deliberately deny login with 403 AFTER PHP executes.
  # Any redirect is followed only as a separate local HTTPS probe. We never
  # follow a redirect onto the Internet or treat a bare 3xx/401/404/5xx as PASS.
  local code health_headers health_body health_version deployment
  local redirect_url redirect_host https_code https_version https_headers https_body
  deployment="$(php -r '$c=parse_ini_file($argv[1],true,INI_SCANNER_TYPED); echo strtolower((string)($c["system"]["deployment"]??"lan"));' "$CONFIG" 2>/dev/null || echo lan)"
  health_headers="$(mktemp)"; health_body="$(mktemp)"
  code="$(curl --noproxy '*' -sS -D "$health_headers" -o "$health_body" -w '%{http_code}' --connect-timeout 2 --max-time 5 "http://127.0.0.1${BASE_URL}login.php" 2>/dev/null || true)"
  health_version="$(awk 'tolower($1)=="x-linux-archive-explorer-version:" {gsub("\r", ""); print $2; exit}' "$health_headers")"
  if [[ "$health_version" == "$VERSION" && ( "$code" == "200" || ( "$deployment" == "public" && "$code" == "403" ) ) ]]; then
    verify_ok "Apache executed Linux Archive Explorer PHP (v$health_version, HTTP $code)"
  elif [[ "$code" =~ ^(301|302|303|307|308)$ ]]; then
    redirect_url="$(awk 'tolower($1)=="location:" {gsub("\r", ""); print $2; exit}' "$health_headers")"
    if [[ "$redirect_url" =~ ^https://([a-zA-Z0-9.-]+)(/|$) ]]; then
      redirect_host="${BASH_REMATCH[1]}"
      https_headers="$(mktemp)"; https_body="$(mktemp)"
      # --resolve pins the redirect host to the local Apache listener, retaining
      # TLS SNI/name-vhost selection. Never contact a remote IP or follow links.
      https_code="$(curl --noproxy '*' -ksS --resolve "${redirect_host}:443:127.0.0.1" -D "$https_headers" -o "$https_body" -w '%{http_code}' --connect-timeout 2 --max-time 5 "https://${redirect_host}${BASE_URL}login.php" 2>/dev/null || true)"
      https_version="$(awk 'tolower($1)=="x-linux-archive-explorer-version:" {gsub("\r", ""); print $2; exit}' "$https_headers")"
      if [[ "$https_version" == "$VERSION" && ( "$https_code" == "200" || ( "$deployment" == "public" && "$https_code" == "403" ) ) ]]; then
        verify_ok "Apache redirects HTTP to HTTPS; local HTTPS executed Linux Archive Explorer PHP (v$https_version, HTTP $https_code)"
      else
        verify_bad "PHP health check failed (HTTP $code to HTTPS; HTTPS ${https_code:-none}, app header ${https_version:-missing})"
      fi
      rm -f -- "$https_headers" "$https_body"
    else
      verify_bad "PHP health check failed (HTTP $code, redirect does not target local HTTPS)"
    fi
  else
    verify_bad "PHP health check failed (HTTP ${code:-none}, app header ${health_version:-missing})"
  fi
  rm -f -- "$health_headers" "$health_body"
  local expected_max expected_backups
  expected_max="$(php -r '$c=parse_ini_file($argv[1],true,INI_SCANNER_TYPED); echo $c["logging"]["max_bytes"]??"";' "$CONFIG" 2>/dev/null || true)"
  expected_backups="$(php -r '$c=parse_ini_file($argv[1],true,INI_SCANNER_TYPED); echo $c["logging"]["backups"]??"";' "$CONFIG" 2>/dev/null || true)"
  [[ "$expected_max" == "5242880" && "$expected_backups" == "2" ]] && verify_ok "Own logs: daily rotation + 5 MiB cap + two old copies configured" || verify_bad "Logging limits differ from expected policy"
  if grep -Eq '^[[:space:]]*(CustomLog|ErrorLog)[[:space:]]' "$APACHE_CONF"; then
    verify_bad "Global LAE Apache integration unexpectedly contains CustomLog/ErrorLog directives"
  elif grep -Eq 'SetEnvIf[[:space:]]+Request_URI[[:space:]]+"\^/linux-archive-explorer/api/\(status\|events\)\\\.php\$"[[:space:]]+dontlog_app_polling_200=1' "$APACHE_CONF" \
    && grep -Fq '/linux-archive-explorer/api/upload.php' "$APACHE_CONF" \
    && grep -Fq '/linux-archive-explorer/api/transfer.php' "$APACHE_CONF"; then
    verify_ok "LAE background/chunk requests are tagged for access-log suppression without replacing existing filters"
  else
    verify_bad "LAE access-log suppression tagging is incomplete"
  fi
  if apache_access_log_filter_compatible; then
    if [[ -e "$TLS_SITE_ENABLED" ]]; then
      verify_ok "LAE-owned HTTP/HTTPS virtual hosts suppress only successful tagged requests"
    else
      verify_ok "Existing Apache access-log policy honors LAE successful-request suppression"
    fi
  else
    verify_bad "No active Apache access.log policy honors LAE successful-request suppression"
  fi
  if ((failures)); then printf '===== VERIFY FAILED: %d issue(s) =====\n' "$failures"; return 1; fi
  printf '===== VERIFY PASSED =====\n'; return 0
}

change_password(){
  need_root; [[ -f "$CONFIG" ]] || die "Linux Archive Explorer is not installed."
  local user new confirm hash
  user="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));admins=[u for u in d.get("users",[]) if u.get("role")=="admin" and u.get("enabled",True)];print((admins or d.get("users",[]))[0]["username"])' "$USERS_DB")"
  if [[ -n "${LAE_ADMIN_USER:-}" ]]; then user="$LAE_ADMIN_USER"; elif [[ -t 0 ]]; then read -r -p "Web login username [$user]: " v; [[ -n "$v" ]] && user="$v"; fi
  [[ "$user" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "Invalid username."
  new="${LAE_ADMIN_PASSWORD:-}"
  if [[ -z "$new" ]]; then
    [[ -t 0 ]] || die "Set LAE_ADMIN_PASSWORD for non-interactive password change."
    while :; do read -r -s -p 'New password (minimum 8 characters): ' new; echo; read -r -s -p 'Confirm password: ' confirm; echo; [[ "$new" == "$confirm" ]] || { warn "Passwords do not match."; continue; }; ((${#new}>=8)) || { warn "Password is too short."; continue; }; break; done
  fi
  ((${#new}>=8)) || die "Password must be at least 8 characters."
  hash="$(hash_password "$new")"; unset new confirm LAE_ADMIN_PASSWORD
  printf '%s' "{\"action\":\"change-user-password\",\"username\":\"$user\",\"password_hash\":\"$hash\"}" | "$ARCHIVE_HELPER" >/dev/null
  # There is no timed failed-login lockout. Clear any obsolete state so a
  # credential recovery performed with this installer can never leave stale lock data behind.
  rm -f -- "$DATA_RUNTIME/login-attempts.json" 2>/dev/null || true
  ok "Web login password changed."
}

uninstall_app(){
  need_root
  [[ "$SOURCE_DIR" == "$APP_ROOT" ]] || die "Uninstall must be run from $APP_ROOT; refusing to remove another directory."
  assert_no_active_work
  [[ -d "$APP_ROOT" || -f "$APACHE_CONF" || -f "$TLS_SITE" || -f "$SUDOERS" || -f "$LOGROTATE_CONF" || -f "$SYSTEMD_SERVICE" || -f "$CLEANUP_SERVICE" || -f "$CLEANUP_TIMER" ]] || die "Linux Archive Explorer is not installed."
  local answer
  echo
  echo "WARNING: UNINSTALL permanently removes Linux Archive Explorer application files, configuration, accounts, archives, jobs, logs and rollback/recovery data."
  echo "Only packages proven by the first-install ledger to have been introduced by Linux Archive Explorer are eligible for safe reversal; pre-existing/shared packages and unrelated Apache configuration are preserved."
  prepare_clean_uninstall
  if [[ -n "${LAE_UNINSTALL_CONFIRM:-}" ]]; then answer="$LAE_UNINSTALL_CONFIRM"; else
    [[ -t 0 ]] || die "Interactive confirmation required: run from a terminal or set LAE_UNINSTALL_CONFIRM=UNINSTALL for controlled testing."
    read -r -p 'Type UNINSTALL to permanently remove all Linux Archive Explorer data: ' answer
  fi
  [[ "$answer" == "UNINSTALL" ]] || { echo 'Cancelled without changes.'; return 0; }
  restore_apache_access_log_patches
  a2disconf linux-archive-explorer >/dev/null 2>&1 || true
  a2dissite linux-archive-explorer-ssl >/dev/null 2>&1 || true
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl disable linux-archive-explorer-recovery.service >/dev/null 2>&1 || true
    systemctl disable --now linux-archive-explorer-cleanup.timer >/dev/null 2>&1 || true
  fi
  rm -f -- "$APACHE_CONF" "$TLS_SITE" "$SUDOERS" "$LOGROTATE_CONF" "$SYSTEMD_SERVICE" "$CLEANUP_SERVICE" "$CLEANUP_TIMER"
  rm -rf -- /etc/linux-archive-explorer
  rm -f -- /var/lib/systemd/timers/stamp-linux-archive-explorer-cleanup.timer 2>/dev/null || true
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
  apache2ctl configtest >/dev/null 2>&1 || die "Apache config became invalid during uninstall; inspect with apache2ctl configtest."
  reload_apache
  # The checkout and installed application share this one directory.
  # If invoked from the checkout, change directory before removing it so a
  # terminal is not left inside a deleted working directory.
  cd / || die "Cannot enter filesystem root for uninstall cleanup."
  rm -rf -- "$APP_ROOT"
  [[ ! -e "$APP_ROOT" ]] || die "Uninstall did not remove $APP_ROOT completely."
  printf '\n[OK] Linux Archive Explorer completely removed.\n'
  printf '[OK] Removed application code, configuration, accounts, archives, jobs, logs and recovery data.\n'
  finish_clean_uninstall
  printf '[OK] First-install package footprint was reversed only where safely proven by the install-state ledger.\n'
}


check_install_collisions(){
  local path
  if [[ $FRESH -eq 1 ]]; then
    for path in "$APACHE_CONF" "$TLS_SITE" "$SUDOERS" "$LOGROTATE_CONF" "$SYSTEMD_SERVICE" "$CLEANUP_SERVICE" "$CLEANUP_TIMER"; do
      if [[ -e "$path" ]] && ! grep -q 'Linux Archive Explorer' "$path" 2>/dev/null; then
        die "Refusing to overwrite pre-existing integration file not owned by Linux Archive Explorer: $path"
      fi
    done
    if [[ -d "$APP_ROOT" ]]; then
      local unexpected
      # On a clean clone, APP_ROOT is itself the checked-out source tree.
      # Accept only known release root names and managed runtime paths.
      unexpected="$(find "$APP_ROOT" -mindepth 1 -maxdepth 1 \
        ! -name .git ! -name .gitignore ! -name install.sh ! -name VERSION ! -name README.md \
        ! -name LICENSE ! -name SECURITY.md ! -name tree.txt ! -name screenshot.png \
        ! -name config.ini.example ! -name setup_linux_archive_explorer.sh \
        ! -name app ! -name bin ! -name public ! -name tests \
        ! -name archives ! -name rollback -printf '%f\n' 2>/dev/null | head -n 1 || true)"
      [[ -z "$unexpected" ]] || die "Refusing fresh install because $APP_ROOT contains unexpected existing content: $unexpected"
    fi
  fi
}

detect_lan_ipv4(){
  local route_ip=""
  if command -v ip >/dev/null 2>&1; then
    route_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src" && (i+1)<=NF){print $(i+1); exit}}' || true)"
  fi
  { [[ -n "$route_ip" ]] && printf '%s\n' "$route_ip"; hostname -I 2>/dev/null | tr ' ' '\n'; } | python3 -c 'import ipaddress,sys; vals=[]
for raw in sys.stdin:
 raw=raw.strip()
 if not raw: continue
 try: ip=ipaddress.ip_address(raw)
 except ValueError: continue
 if ip.version==4 and not ip.is_loopback and ip not in vals: vals.append(ip)
priv=[ip for ip in vals if ip.is_private]
print((priv or vals)[0] if (priv or vals) else "")' 2>/dev/null || true
}

installed_admin_username(){
  [[ -f "$USERS_DB" ]] || return 0
  python3 - "$USERS_DB" <<'PYUSER'
import json,sys
try:
    data=json.load(open(sys.argv[1],encoding='utf-8'))
except Exception:
    raise SystemExit(0)
users=[u for u in data.get('users',[]) if isinstance(u,dict)]
admins=[u for u in users if u.get('role')=='admin' and u.get('enabled',True)]
if admins: print(admins[0].get('username',''))
PYUSER
}

detect_https_url(){
  command -v apache2ctl >/dev/null 2>&1 || return 0
  command -v curl >/dev/null 2>&1 || return 0
  apache2ctl -M 2>/dev/null | grep -q ssl_module || return 0
  local host ip https_code
  # Prefer the actual LAN-IP HTTPS endpoint whenever this Apache instance serves
  # LAE there, regardless of whether the certificate belongs to LAE or was
  # already configured by the administrator/another application.
  ip="$(detect_primary_ipv4)"
  if [[ -n "$ip" ]]; then
    https_code="$(curl --noproxy "*" -ksS --resolve "${ip}:443:127.0.0.1" \
      --connect-timeout 2 --max-time 4 -o /dev/null -w '%{http_code}' \
      "https://${ip}${BASE_URL}" 2>/dev/null || true)"
    if [[ "$https_code" =~ ^[23][0-9][0-9]$ ]]; then
      printf "https://%s%s\n" "$ip" "$BASE_URL"
      return 0
    fi
  fi
  local host
  while IFS= read -r host; do
    [[ -n "$host" ]] || continue
    # Certificates are normally issued to DNS names, not RFC1918 LAN IPs.
    if ! python3 - "$host" <<'PYHOST' >/dev/null 2>&1
import ipaddress,re,sys
h=sys.argv[1].strip().rstrip('.')
if not h or h in {'localhost','_default_'}: raise SystemExit(1)
try:
    ipaddress.ip_address(h)
    raise SystemExit(1)
except ValueError:
    pass
if not re.fullmatch(r'(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?',h): raise SystemExit(1)
PYHOST
    then continue; fi
    # Resolve to loopback deliberately: this verifies this Apache vhost and its
    # certificate identity without relying on router hairpin/NAT behavior.
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 4 \
      --resolve "${host}:443:127.0.0.1" "https://${host}${BASE_URL}" -o /dev/null 2>/dev/null; then
      printf 'https://%s%s\n' "$host" "$BASE_URL"
      return 0
    fi
  done < <(apache2ctl -S 2>&1 | awk '/port 443 namevhost/ {print $4}' | sed 's/[()]//g' | sort -u)
}

install_or_update(){
  need_root
  assert_no_active_work; detect_platform; installer_free_space_preflight
  [[ -e "$APP_ROOT" ]] && APP_ROOT_PREEXISTED=1 || APP_ROOT_PREEXISTED=0
  if [[ -d "$CURRENT" || -f "$CONFIG" || -f "$LEGACY_CONFIG" ]]; then FRESH=0; else FRESH=1; fi
  printf 'Linux Archive Explorer v%s\n' "$VERSION"
  if [[ "$ACTION" == "--repair" ]]; then
    printf 'Repairing Linux Archive Explorer...\n'
  elif [[ $FRESH -eq 1 ]]; then
    printf 'Installing Linux Archive Explorer...\n'
  else
    printf 'Updating Linux Archive Explorer...\n'
  fi
  printf 'Please wait while setup completes. Do not interrupt.\n'
  init_install_state
  ensure_packages; [[ $FRESH -eq 1 ]] && record_web_baseline_after_bootstrap || true; check_source
  check_install_collisions
  if [[ $FRESH -eq 1 ]]; then
    # Collect/validate all interactive first-run choices before creating the
    # application tree. Cancelling or rejecting a prompt leaves no app files.
    prompt_deployment
    prompt_credentials
    MODIFIED=1
    make_persistent_dirs
    write_new_config
    write_initial_users_db
  else
    create_protected_backup
    MODIFIED=1
    # One-way protected migration: copy legacy config to the application root;
    # leave the legacy file untouched until the updated release is accepted.
    if [[ ! -f "$CONFIG" && -f "$LEGACY_CONFIG" ]]; then
      install -o root -g www-data -m 0640 "$LEGACY_CONFIG" "$CONFIG"
    fi
    [[ -f "$CONFIG" ]] || die "Existing configuration is missing; protected backup is retained."
    make_persistent_dirs
    # Preserve deployment/reverse-proxy settings on update unless the administrator explicitly overrides them.
    if [[ -n "${LAE_DEPLOYMENT:-}" || -n "${LAE_TRUSTED_PROXIES:-}" ]]; then
      prompt_deployment
    else
      LAE_DEPLOYMENT_SELECTED="$(php -r '$c=parse_ini_file($argv[1],true,INI_SCANNER_TYPED); echo $c["system"]["deployment"]??"lan";' "$CONFIG" 2>/dev/null || echo lan)"
      LAE_TRUSTED_PROXIES_SELECTED="$(php -r '$c=parse_ini_file($argv[1],true,INI_SCANNER_TYPED); echo $c["system"]["trusted_proxies"]??"";' "$CONFIG" 2>/dev/null || true)"
    fi
    # Migrate an older single-admin credential before sanitizing config.ini.
    migrate_users_db
    migrate_config
  fi
  stage_release
  build_integration_files
  activate_release
  ensure_local_https
  patch_apache_access_log_if_needed
  if [[ -s "$TLS_CA" ]]; then install -o root -g root -m 0644 "$TLS_CA" "$CURRENT/public/linux-archive-explorer-local-ca.crt"; fi
  # Normalize persistent ownership/modes after Apache has switched to the new
  # release. Older installs allowed group-writable data/; the runtime-state
  # directory is now the only group-writable child while the parent is protected
  # and confines writable state to data/runtime.
  make_persistent_dirs
  # Remove obsolete timed-login-lockout state left by older versions.
  rm -f -- "$DATA_RUNTIME/login-attempts.json" 2>/dev/null || true
  local verify_log
  verify_log="$(mktemp)"
  if ( verify_installation ) >"$verify_log" 2>&1; then
    rm -f -- "$verify_log"
    ok "Installation and security checks passed."
  else
    grep -E '^\[FAIL\]|^===== VERIFY FAILED:' "$verify_log" >&2 || true
    rm -f -- "$verify_log"
    die "Installation verification failed; use --verify for detailed diagnostics."
  fi
  finalize_install_state
  MODIFIED=0
  # Prune older verified installer snapshots ONLY after the new release is
  # verified and the automatic rollback trap is no longer armed.
  if [[ -x "$CURRENT/bin/storage-maintenance.py" ]]; then
    "$CURRENT/bin/storage-maintenance.py" --auto >/dev/null || say "Storage cleanup needs attention: review Settings > Cleanup & Storage."
  fi
  [[ -n "$OLD_CURRENT" && -d "$OLD_CURRENT" ]] && rm -rf "$OLD_CURRENT"
  cleanup_tmp
  printf '[OK] Linux Archive Explorer v%s installed and verified.\n' "$VERSION"
  local lan_ip admin_user https_url
  lan_ip="$(detect_lan_ipv4)"; admin_user="$(installed_admin_username)"; https_url="$(detect_https_url || true)"
  printf 'Web login username: %s\n' "${admin_user:-admin}"
  if [[ -n "$https_url" ]]; then
    printf 'Open in your browser: %s\n' "$https_url"
  elif [[ -n "$lan_ip" ]]; then
    printf 'Open in your browser: http://%s%s\n' "$lan_ip" "$BASE_URL"
  else
    printf 'URL path: %s\n' "$BASE_URL"
  fi
  printf 'Saved Linux archives: %s\n' "$ARCHIVES"
  if [[ -n "$BACKUP_TAR" ]]; then ok 'Previous installation recovery point retained.'; fi
  return 0
}


case "$ACTION" in
  --help|-h ) usage; exit 0 ;;
  ""|--repair|--verify|--change-password|--uninstall )
    need_root; acquire_setup_lock ;;
  * ) die "Unknown option: $ACTION. Run --help for supported commands." ;;
esac

case "$ACTION" in
  ""|--repair ) install_or_update ;;
  --verify ) detect_platform; verify_installation ;;
  --change-password ) change_password ;;
  --uninstall ) uninstall_app ;;
esac
