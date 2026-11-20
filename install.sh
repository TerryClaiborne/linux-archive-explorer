#!/usr/bin/env bash
# Linux Archive Explorer first-install bootstrap.
# Designed for the official GitHub README one-command install.
set -Eeuo pipefail
umask 027

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'ERROR: Run with sudo.' >&2; exit 1; }
[[ -r /etc/os-release ]] || { echo 'ERROR: Cannot identify OS.' >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == debian && "${VERSION_ID:-}" == 13 ]] || { echo 'ERROR: Debian 13 required.' >&2; exit 1; }
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) echo 'ERROR: Supported architectures are amd64 and arm64.' >&2; exit 1;; esac

APP=/var/www/linux-archive-explorer
REPO_URL="${LAE_REPO_URL:-https://github.com/TerryClaiborne/linux-archive-explorer.git}"
LOCAL_SOURCE="${LAE_SOURCE_DIR:-}"
STATE_DIR=/var/lib/linux-archive-explorer
STATE_META="$STATE_DIR/install-state.env"
STATE_PRE="$STATE_DIR/packages-before.txt"
BOOTSTRAP_OK=0
APP_CREATED=0
VAR_WWW_PREEXISTED=0
APACHE_PREINSTALLED=0
APACHE_WAS_ACTIVE=0
APACHE_WAS_ENABLED=0
[[ -e /var/www ]] && VAR_WWW_PREEXISTED=1

dpkg-query -W -f='${Status}' apache2 2>/dev/null | grep -qx 'install ok installed' && APACHE_PREINSTALLED=1 || true
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  systemctl is-active --quiet apache2 2>/dev/null && APACHE_WAS_ACTIVE=1 || true
  systemctl is-enabled --quiet apache2 2>/dev/null && APACHE_WAS_ENABLED=1 || true
elif pgrep -x apache2 >/dev/null 2>&1; then
  APACHE_WAS_ACTIVE=1
fi

rollback_bootstrap(){
  local rc=$?
  [[ $BOOTSTRAP_OK -eq 1 || $rc -eq 0 ]] && return 0
  echo >&2
  echo 'Linux Archive Explorer first installation failed; attempting guarded rollback.' >&2
  if [[ $APP_CREATED -eq 1 && -e "$APP" ]]; then
    a2disconf linux-archive-explorer >/dev/null 2>&1 || true
    a2dissite linux-archive-explorer-ssl >/dev/null 2>&1 || true
    rm -rf -- "$APP" /etc/linux-archive-explorer/tls 2>/dev/null || true
    rm -f -- /etc/apache2/conf-available/linux-archive-explorer.conf \
      /etc/apache2/sites-available/linux-archive-explorer-ssl.conf \
      /etc/sudoers.d/linux-archive-explorer \
      /etc/logrotate.d/linux-archive-explorer \
      /etc/systemd/system/linux-archive-explorer-recovery.service \
      /etc/systemd/system/linux-archive-explorer-cleanup.service \
      /etc/systemd/system/linux-archive-explorer-cleanup.timer 2>/dev/null || true
  fi
  if [[ -s "$STATE_PRE" ]]; then
    local now added sim bad=0 p
    now="$(mktemp)"; added="$(mktemp)"; sim="$(mktemp)"
    dpkg-query -W -f='${binary:Package}\n' 2>/dev/null | LC_ALL=C sort -u > "$now"
    LC_ALL=C comm -13 <(LC_ALL=C sort -u "$STATE_PRE") <(LC_ALL=C sort -u "$now") > "$added"
    if [[ -s "$added" ]]; then
      mapfile -t pkgs < "$added"
      if DEBIAN_FRONTEND=noninteractive apt-get -s purge "${pkgs[@]}" > "$sim" 2>&1; then
        declare -A allowed=(); for p in "${pkgs[@]}"; do allowed["${p%%:*}"]=1; done
        while read -r _ p _; do [[ -n "${allowed[${p%%:*}]+x}" ]] || { bad=1; break; }; done < <(awk '/^(Remv|Purg) /{print $1,$2,$3}' "$sim")
        if [[ $bad -eq 0 ]]; then
          DEBIAN_FRONTEND=noninteractive apt-get -y purge "${pkgs[@]}" >/dev/null 2>&1 || true
        else
          echo 'WARNING: package rollback was not safe; newly installed packages were preserved.' >&2
        fi
      fi
    fi
    rm -f -- "$now" "$added" "$sim"
  fi
  if [[ $VAR_WWW_PREEXISTED -eq 0 && -d /var/www ]]; then
    # A fresh Debian Apache install creates only /var/www/html/index.html.
    # Remove that stock bootstrap web-root directory only if nothing else appeared.
    if [[ -d /var/www/html ]] && ! find /var/www -mindepth 1 \
        ! -path /var/www/html ! -path /var/www/html/index.html -print -quit 2>/dev/null | grep -q .; then
      rm -f -- /var/www/html/index.html 2>/dev/null || true
      rmdir /var/www/html 2>/dev/null || true
    fi
    rmdir /var/www 2>/dev/null || true
  fi
  rm -rf -- "$STATE_DIR" 2>/dev/null || true
  echo 'Guarded rollback completed as far as safely possible.' >&2
  return "$rc"
}
trap rollback_bootstrap EXIT

[[ ! -e "$APP" && ! -L "$APP" ]] || { echo 'ERROR: Application directory already exists. Use the update instructions.' >&2; exit 1; }
install -d -o root -g root -m 0700 "$STATE_DIR"
dpkg-query -W -f='${binary:Package}\n' 2>/dev/null | LC_ALL=C sort -u > "$STATE_PRE"
chmod 0600 "$STATE_PRE"
{
  printf 'LAE_INSTALL_STATE_VERSION=1\n'
  printf 'VAR_WWW_PREEXISTED=%s\n' "$VAR_WWW_PREEXISTED"
  printf 'APACHE_PREINSTALLED=%s\n' "$APACHE_PREINSTALLED"
  printf 'APACHE_WAS_ACTIVE=%s\n' "$APACHE_WAS_ACTIVE"
  printf 'APACHE_WAS_ENABLED=%s\n' "$APACHE_WAS_ENABLED"
  printf 'CREATED_BY=install.sh\n'
} > "$STATE_META"
chmod 0600 "$STATE_META"

required=(apache2 git ca-certificates python3 procps util-linux curl openssl)
missing=()
for pkg in "${required[@]}"; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -qx 'install ok installed' || missing+=("$pkg")
done
if ((${#missing[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt_log="$(mktemp)"
  if ! apt-get update -qq >"$apt_log" 2>&1 || ! apt-get install -y -qq "${missing[@]}" >>"$apt_log" 2>&1; then
    cat "$apt_log" >&2
    rm -f -- "$apt_log"
    echo 'ERROR: Failed to install required bootstrap packages.' >&2
    exit 1
  fi
  rm -f -- "$apt_log"
fi

command -v apache2ctl >/dev/null 2>&1 || { echo 'ERROR: apache2ctl is unavailable.' >&2; exit 1; }
apache2ctl configtest >/dev/null 2>&1 || { echo 'ERROR: Existing Apache configuration is invalid; LAE was not deployed.' >&2; exit 1; }
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  if [[ $APACHE_PREINSTALLED -eq 0 ]]; then
    systemctl enable --now apache2 >/dev/null 2>&1
  elif ! systemctl is-active --quiet apache2; then
    systemctl start apache2 >/dev/null 2>&1
  fi
  systemctl is-active --quiet apache2 || { echo 'ERROR: Apache2 did not start.' >&2; exit 1; }
else
  pgrep -x apache2 >/dev/null 2>&1 || apache2ctl start >/dev/null 2>&1
  pgrep -x apache2 >/dev/null 2>&1 || { echo 'ERROR: Apache2 did not start.' >&2; exit 1; }
fi

install -d -m 0755 /var/www
if [[ -n "$LOCAL_SOURCE" ]]; then
  [[ -d "$LOCAL_SOURCE" && -f "$LOCAL_SOURCE/VERSION" && -f "$LOCAL_SOURCE/setup_linux_archive_explorer.sh" ]] || { echo 'ERROR: LAE_SOURCE_DIR is incomplete.' >&2; exit 1; }
  mkdir -p "$APP"
  cp -a "$LOCAL_SOURCE"/. "$APP"/
else
  git clone -q -- "$REPO_URL" "$APP"
fi
APP_CREATED=1
[[ -f "$APP/VERSION" && -f "$APP/setup_linux_archive_explorer.sh" ]] || { echo 'ERROR: Incomplete checkout.' >&2; exit 1; }

# The README bootstrap is piped into bash, so stdin is the pipe. Reconnect setup
# to the controlling terminal so the Administrator password can be entered in
# the same public one-command install without putting a password in a script.
if ( : </dev/tty ) 2>/dev/null; then
  bash "$APP/setup_linux_archive_explorer.sh" </dev/tty
else
  bash "$APP/setup_linux_archive_explorer.sh"
fi
BOOTSTRAP_OK=1
trap - EXIT
exit 0
