<?php
declare(strict_types=1);

function lae_release_version(): string
{
    $path = dirname(__DIR__).'/VERSION';
    $value = is_readable($path) ? trim((string)file_get_contents($path)) : '';
    if (!preg_match('/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/', $value)) {
        throw new RuntimeException('Linux Archive Explorer VERSION is missing or invalid.');
    }
    return $value;
}

define('LAE_VERSION', lae_release_version());
const LAE_PRODUCT = 'Linux Archive Explorer';

function lae_config_path(): string
{
    return getenv('LAE_CONFIG') ?: '/var/www/linux-archive-explorer/config.ini';
}

function lae_config(): array
{
    static $cfg = null;
    if ($cfg !== null) return $cfg;

    $path = lae_config_path();
    if (!is_readable($path)) {
        if (getenv('LAE_DEV') === '1') {
            $root = dirname(__DIR__);
            $cfg = [
                'application' => ['version' => LAE_VERSION, 'base_url' => '/', 'session_timeout' => 1800, 'default_format' => 'tar.gz'],
                'auth' => ['auth_bypass' => true],
                'paths' => [
                    'root' => $root,
                    'jobs' => $root.'/.dev/jobs', 'staging' => $root.'/.dev/staging',
                    'uploads' => $root.'/.dev/uploads', 'archives' => $root.'/.dev/archives',
                    'rollback' => $root.'/.dev/rollback', 'logs' => $root.'/.dev/logs',
                ],
                'system' => ['archive_helper' => $root.'/bin/archive-helper.py', 'restore_helper' => $root.'/bin/restore-helper.py', 'use_sudo' => false, 'deployment' => 'lan', 'trusted_proxies' => ''],
                'logging' => ['max_bytes' => 5242880, 'backups' => 2],
                'updates' => ['version_url' => '', 'release_url' => ''],
                'limits' => ['upload_max_bytes' => 268435456, 'upload_chunk_bytes' => 8388608],
            ];
            return $cfg;
        }
        throw new RuntimeException('Linux Archive Explorer is not configured. Run the installer.');
    }
    $parsed = parse_ini_file($path, true, INI_SCANNER_TYPED);
    if (!is_array($parsed)) throw new RuntimeException('Linux Archive Explorer config.ini is invalid.');
    $cfg = $parsed;
    $cfg['application'] = ($cfg['application'] ?? []) + ['version' => LAE_VERSION, 'base_url' => '/linux-archive-explorer/', 'session_timeout' => 1800, 'default_format' => 'tar.gz'];
    $cfg['auth'] = ($cfg['auth'] ?? []) + ['auth_bypass' => false];
    $root = (string)(($cfg['paths']['root'] ?? '') ?: '/var/www/linux-archive-explorer');
    $cfg['paths'] = ($cfg['paths'] ?? []) + [
        'root' => $root, 'jobs' => $root.'/jobs', 'staging' => $root.'/staging', 'uploads' => $root.'/uploads',
        'archives' => $root.'/archives', 'rollback' => $root.'/rollback', 'logs' => $root.'/logs',
    ];
    $cfg['system'] = ($cfg['system'] ?? []) + [
        'archive_helper' => $root.'/current/bin/archive-helper.py', 'restore_helper' => $root.'/current/bin/restore-helper.py',
        'use_sudo' => true, 'deployment' => 'lan', 'trusted_proxies' => '',
    ];
    $cfg['logging'] = ($cfg['logging'] ?? []) + ['max_bytes' => 5242880, 'backups' => 2];
    $cfg['updates'] = ($cfg['updates'] ?? []) + ['version_url' => '', 'release_url' => ''];
    $cfg['limits'] = ($cfg['limits'] ?? []) + ['upload_max_bytes' => 268435456, 'upload_chunk_bytes' => 8388608];
    return $cfg;
}

function lae_base_url(): string
{
    $base = (string)lae_config()['application']['base_url'];
    if ($base === '' || $base[0] !== '/') $base = '/linux-archive-explorer/';
    return rtrim($base, '/').'/';
}

function lae_is_secure_request(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') return true;
    $cfg = lae_config();
    $trusted = trim((string)($cfg['system']['trusted_proxies'] ?? ''));
    if ($trusted === '') return false;
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    $allowed = array_values(array_filter(array_map('trim', explode(',', $trusted))));
    if (!in_array($remote, $allowed, true)) return false;
    return strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
}

function lae_users_path(): string
{
    $cfg = lae_config();
    $data = (string)($cfg['paths']['data'] ?? (rtrim((string)$cfg['paths']['root'], '/').'/data'));
    return rtrim($data, '/').'/users.json';
}

function lae_users(): array
{
    $path = lae_users_path();
    if (!is_readable($path)) {
        throw new RuntimeException('User database is missing or unreadable. Run installer Verify/Repair.');
    }
    $raw = json_decode((string)file_get_contents($path), true);
    if (!is_array($raw) || !is_array($raw['users'] ?? null)) {
        throw new RuntimeException('User database is invalid. Run installer Verify/Repair.');
    }
    return $raw['users'];
}

function lae_find_user(string $username): ?array
{
    foreach (lae_users() as $user) {
        if (!is_array($user)) continue;
        if (hash_equals((string)($user['username'] ?? ''), $username)) return $user;
    }
    return null;
}

function lae_session_timeout(): int
{
    return max(300, min(43200, (int)(lae_config()['application']['session_timeout'] ?? 1800)));
}

function lae_current_user(): ?array
{
    lae_start_session();
    if (empty($_SESSION['lae_authenticated'])) return null;
    $username = (string)($_SESSION['lae_username'] ?? '');
    $user = lae_find_user($username);
    if (!$user || empty($user['enabled'])) return null;
    return [
        'username' => (string)$user['username'],
        'role' => strtolower((string)($user['role'] ?? 'user')) === 'admin' ? 'admin' : 'user',
    ];
}

function lae_is_admin(): bool
{
    $user = lae_current_user();
    return $user !== null && $user['role'] === 'admin';
}

function lae_require_admin(bool $json = true): void
{
    lae_require_auth($json);
    if (lae_is_admin()) return;
    if ($json) lae_json(['ok' => false, 'error' => 'Administrator permission is required for this action.'], 403);
    http_response_code(403);
    exit('Administrator permission is required.');
}

function lae_start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $timeout = lae_session_timeout();
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.cookie_httponly', '1');
    ini_set('session.cookie_samesite', 'Strict');
    session_name('linux_archive_explorer');
    session_set_cookie_params([
        'lifetime' => 0, 'path' => lae_base_url(), 'secure' => lae_is_secure_request(),
        'httponly' => true, 'samesite' => 'Strict',
    ]);
    session_start();
    $now = time();
    if (!empty($_SESSION['lae_authenticated'])) {
        $last = (int)($_SESSION['lae_last_activity'] ?? 0);
        if ($last > 0 && ($now - $last) > $timeout) {
            lae_destroy_session();
            session_start();
        } else {
            $_SESSION['lae_last_activity'] = $now;
        }
    }
}

function lae_destroy_session(): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) return;
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'] ?? '', (bool)$p['secure'], (bool)$p['httponly']);
    }
    session_destroy();
}

function lae_logged_in(): bool
{
    $cfg = lae_config();
    // Even development auth bypass needs a real session because job/upload
    // ownership is deliberately tied to the browser session.
    lae_start_session();
    if (!empty($cfg['auth']['auth_bypass'])) return true;
    if (empty($_SESSION['lae_authenticated'])) return false;
    $user = lae_find_user((string)($_SESSION['lae_username'] ?? ''));
    return $user !== null && !empty($user['enabled']);
}

function lae_require_auth(bool $json = true): void
{
    if (lae_logged_in()) return;
    if ($json) lae_json(['ok' => false, 'error' => 'Your login session has expired. Please sign in again.', 'login_required' => true], 401);
    $target = lae_base_url().'login.php';
    header('Location: '.$target, true, 302);
    exit;
}

function lae_csrf_token(): string
{
    lae_start_session();
    if (empty($_SESSION['lae_csrf'])) $_SESSION['lae_csrf'] = bin2hex(random_bytes(32));
    return (string)$_SESSION['lae_csrf'];
}

function lae_require_csrf(): void
{
    lae_start_session();
    $sent = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['csrf'] ?? ''));
    if ($sent === '' || empty($_SESSION['lae_csrf']) || !hash_equals((string)$_SESSION['lae_csrf'], $sent)) {
        lae_audit('security.csrf_failure', ['ip' => lae_client_ip()]);
        lae_json(['ok' => false, 'error' => 'Invalid security token. Refresh the page and try again.'], 403);
    }
}

function lae_client_ip(): string
{
    return substr((string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 0, 64);
}

function lae_failed_login_delay(): void
{
    // Deliberately slow repeated password guessing without locking out the legitimate user.
    usleep(500000);
}

function lae_json(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('Pragma: no-cache');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function lae_input_json(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) lae_json(['ok' => false, 'error' => 'Request body must be valid JSON.'], 400);
    return $data;
}

function lae_helper(string $which, string $action, array $payload = []): array
{
    $cfg = lae_config();
    $helper = $which === 'restore' ? (string)$cfg['system']['restore_helper'] : (string)$cfg['system']['archive_helper'];
    $cmd = [];
    if (!empty($cfg['system']['use_sudo'])) { $cmd[] = '/usr/bin/sudo'; $cmd[] = '-n'; }
    $cmd[] = $helper;
    $spec = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    // Use a deliberately small, deterministic environment. Apache/PHP often
    // leaves $_ENV empty; helpers still need a safe system PATH for certified
    // utilities and must never inherit browser-controlled environment values.
    $env = [
        'LAE_CONFIG' => lae_config_path(),
        'PATH' => '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'LANG' => 'C.UTF-8',
        'LC_ALL' => 'C.UTF-8',
    ];
    $proc = proc_open($cmd, $spec, $pipes, null, $env, ['bypass_shell' => true]);
    if (!is_resource($proc)) throw new RuntimeException('Unable to start the privileged helper.');
    $request = ['action' => $action] + $payload;
    fwrite($pipes[0], json_encode($request, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]); $stderr = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
    $exit = proc_close($proc);
    $decoded = json_decode((string)$stdout, true);
    if ($exit !== 0 || !is_array($decoded) || empty($decoded['ok'])) {
        $message = is_array($decoded) && !empty($decoded['error']) ? (string)$decoded['error'] : (trim((string)$stderr) ?: 'Privileged helper failed.');
        throw new RuntimeException($message);
    }
    unset($decoded['ok']);
    return $decoded;
}

function lae_audit(string $event, array $details = []): void
{
    try { lae_helper('archive', 'log-event', ['event' => $event, 'details' => $details]); } catch (Throwable $e) { error_log('Linux Archive Explorer audit log failure: '.$e->getMessage()); }
}

function lae_valid_job_id(string $id): bool { return (bool)preg_match('/^[a-f0-9]{32}$/', $id); }

function lae_job_status(string $id): array
{
    if (!lae_valid_job_id($id)) throw new RuntimeException('Invalid job id.');
    $path = rtrim((string)lae_config()['paths']['jobs'], '/').'/'.$id.'.json';
    if (!is_readable($path)) throw new RuntimeException('Job not found.');
    $data = json_decode((string)file_get_contents($path), true);
    if (!is_array($data)) throw new RuntimeException('Job status is unreadable.');
    return $data;
}

function lae_public_job(array $job): array
{
    foreach (['staged_path', 'archive_path', 'selected_paths', 'restore_lock', 'manifest'] as $key) unset($job[$key]);
    return $job;
}

function lae_hash_password(string $password): string
{
    if (defined('PASSWORD_ARGON2ID')) return password_hash($password, PASSWORD_ARGON2ID);
    return password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
}

function lae_validate_new_password(string $password): ?string
{
    if (strlen($password) < 8) return 'Password must be at least 8 characters.';
    if (strlen($password) > 256) return 'Password is too long.';
    return null;
}

function lae_update_info(): array
{
    $cfg = lae_config();
    $url = trim((string)($cfg['updates']['version_url'] ?? ''));
    $release = trim((string)($cfg['updates']['release_url'] ?? ''));
    if ($url === '') return ['available' => false, 'current' => LAE_VERSION, 'latest' => null, 'release_url' => $release];
    lae_start_session();
    $cache = $_SESSION['lae_update_cache'] ?? null;
    if (is_array($cache) && is_array($cache['data'] ?? null) && (time() - (int)($cache['checked_at'] ?? 0)) < 21600 && (($cache['data']['current'] ?? null) === LAE_VERSION)) return $cache['data'];
    $ctx = stream_context_create(['http' => ['timeout' => 3, 'user_agent' => 'Linux Archive Explorer/'.LAE_VERSION], 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
    $raw = @file_get_contents($url, false, $ctx);
    $latest = $raw === false ? null : trim($raw);
    $valid = is_string($latest) && preg_match('/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/', $latest);
    $data = ['available' => $valid ? version_compare($latest, LAE_VERSION, '>') : false, 'current' => LAE_VERSION, 'latest' => $valid ? $latest : null, 'release_url' => $release];
    $_SESSION['lae_update_cache'] = ['checked_at' => time(), 'data' => $data];
    return $data;
}

function lae_enforce_transport_security(): void
{
    if (PHP_SAPI === 'cli') return;
    $deployment = strtolower(trim((string)(lae_config()['system']['deployment'] ?? 'lan')));
    if ($deployment !== 'public' || lae_is_secure_request()) return;
    http_response_code(403);
    header('X-Linux-Archive-Explorer-Version: '.LAE_VERSION);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    $uri = (string)($_SERVER['REQUEST_URI'] ?? '');
    if (str_contains($uri, '/api/')) {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => false, 'error' => 'Public/Cloud mode requires HTTPS. Check TLS or the configured trusted reverse proxy.'], JSON_UNESCAPED_SLASHES);
    } else {
        header('Content-Type: text/plain; charset=utf-8');
        echo "Linux Archive Explorer Public/Cloud mode requires HTTPS. Check TLS or the configured trusted reverse proxy.\n";
    }
    exit;
}

function lae_security_headers(): void
{
    header('X-Linux-Archive-Explorer-Version: '.LAE_VERSION);
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    header('Cache-Control: no-store');
    if (lae_is_secure_request()) header('Strict-Transport-Security: max-age=31536000');
}

function lae_log_php_error(string $message): void
{
    try {
        $cfg = lae_config();
        $dir = rtrim((string)$cfg['paths']['logs'], '/').'/app';
        if (!is_dir($dir) || !is_writable($dir)) throw new RuntimeException('application log directory unavailable');
        $path = $dir.'/app-error.log';
        $lockPath = $dir.'/.php-log.lock';
        $lock = @fopen($lockPath, 'c+');
        if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('log lock unavailable');
        $max = max(262144, (int)$cfg['logging']['max_bytes']);
        $backups = max(1, min(10, (int)$cfg['logging']['backups']));
        $rotate = false;
        if (is_file($path)) {
            $mtime = (int)@filemtime($path); $size = (int)@filesize($path);
            $rotate = ($mtime > 0 && date('Y-m-d', $mtime) !== date('Y-m-d')) || $size >= $max;
        }
        if ($rotate) {
            @unlink($path.'.'.$backups);
            for ($i=$backups-1; $i>=1; $i--) if (is_file($path.'.'.$i)) @rename($path.'.'.$i, $path.'.'.($i+1));
            if (is_file($path)) @rename($path, $path.'.1');
        }
        $record = ['time'=>gmdate('c'), 'event'=>'php.error', 'message'=>substr($message,0,4000)];
        @file_put_contents($path, json_encode($record, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE)."\n", FILE_APPEND|LOCK_EX);
        @chmod($path, 0660);
        flock($lock, LOCK_UN); fclose($lock);
        return;
    } catch (Throwable $e) {
        error_log('[Linux Archive Explorer] '.$message);
    }
}

set_error_handler(function(int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) return false;
    lae_log_php_error($message.' in '.$file.':'.$line);
    return true;
});

lae_enforce_transport_security();
if (PHP_SAPI !== 'cli') lae_security_headers();

/** Admission check: uploads must fit a small card even if legacy config allows 100 GiB.
 *  This checks reserved upload metadata as well as files already written.
 *  Never touches user archives or protected recovery files.
 */
function lae_free_space_reserve(int $total): int
{
    $mib = 1024 * 1024;
    if ($total < 5 * 1024 * $mib) return max(4 * $mib, (int)floor($total * 0.10));
    return max(512 * $mib, (int)floor($total * 0.10));
}

function lae_check_upload_space(string $dir, int $size): void
{
    $limit = 256 * 1024 * 1024;
    if ($size < 0 || $size > $limit) {
        throw new RuntimeException('The temporary upload limit is 256 MiB. Choose a smaller file.');
    }
    $used = 0;
    foreach (new DirectoryIterator($dir) as $entry) {
        if ($entry->isDot() || $entry->isLink()) continue;
        if ($entry->isFile() && str_ends_with($entry->getFilename(), '.json')) {
            $meta = json_decode((string)@file_get_contents($entry->getPathname()), true);
            if (is_array($meta) && isset($meta['size']) && is_numeric($meta['size'])) {
                $used += max(0, (int)$meta['size']);
            }
        }
    }
    if ($used + $size > $limit) {
        throw new RuntimeException('Temporary uploads would exceed the 256 MiB storage limit. Finish or cancel previous uploads.');
    }
    $total = @disk_total_space($dir);
    $free = @disk_free_space($dir);
    if ($total === false || $free === false) throw new RuntimeException('Unable to check available disk space.');
    $reserve = lae_free_space_reserve((int)$total);
    if ($free < $size + $reserve) {
        throw new RuntimeException('Not enough safe free disk space for this upload.');
    }
}
