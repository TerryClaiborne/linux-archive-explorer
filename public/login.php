<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';
lae_security_headers();
lae_start_session();
// A normal GET while already authenticated returns to the application.
// A POST must still be processed so a stale/back-cached login form can
// intentionally switch accounts instead of silently retaining the old role.
if ($_SERVER['REQUEST_METHOD'] !== 'POST' && lae_logged_in()) {
    header('Location: '.lae_base_url(), true, 302);
    exit;
}
$error = '';
$username = '';
if (empty($_SESSION['lae_login_csrf'])) {
    $_SESSION['lae_login_csrf'] = bin2hex(random_bytes(32));
}
$loginCsrf = (string)$_SESSION['lae_login_csrf'];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim((string)($_POST['username'] ?? ''));
    $password = (string)($_POST['password'] ?? '');
    $csrf = (string)($_POST['csrf'] ?? '');
    if ($csrf === '' || !hash_equals($loginCsrf, $csrf)) {
        $error = 'The login page expired. Refresh and try again.';
    } else {
        $user = lae_find_user($username);
        $validUser = $user !== null && !empty($user['enabled']);
        $validPass = $validUser && password_verify($password, (string)($user['password_hash'] ?? ''));
        if ($validPass) {
            // Account switches must not inherit the previous user's session-
            // scoped jobs, uploads, restore plans, CSRF token, or privileges.
            $_SESSION = [];
            session_regenerate_id(true);
            $_SESSION['lae_login_csrf'] = $loginCsrf;
            $_SESSION['lae_authenticated'] = true;
            $_SESSION['lae_username'] = $username;
            $_SESSION['lae_role'] = strtolower((string)($user['role'] ?? 'user')) === 'admin' ? 'admin' : 'user';
            $_SESSION['lae_last_activity'] = time();
            $_SESSION['lae_csrf'] = bin2hex(random_bytes(32));
            lae_audit('auth.login_success', ['ip' => lae_client_ip(), 'username' => $username]);
            header('Location: '.lae_base_url(), true, 302); exit;
        }
        lae_audit('auth.login_failure', ['ip' => lae_client_ip(), 'username' => $username]);
        lae_failed_login_delay();
        $error = 'Incorrect username or password.';
    }
    $password = '';
}
$csrf = $loginCsrf;
?>
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="assets/theme-init.js?v=<?= substr(hash_file('sha256', __DIR__ . '/assets/theme-init.js'), 0, 12) ?>"></script><title>Login — Linux Archive Explorer</title><link rel="stylesheet" href="assets/app.css?v=<?= substr(hash_file('sha256', __DIR__ . '/assets/app.css'), 0, 12) ?>"></head>
<body class="login-page"><script src="assets/login.js?v=<?= substr(hash_file('sha256', __DIR__ . '/assets/login.js'), 0, 12) ?>" defer></script><button class="login-theme-toggle" id="loginThemeToggle" type="button" data-theme-preload-toggle aria-label="Switch to Dark mode" title="Switch to Dark mode">☾ Dark</button><main class="login-card"><div class="login-logo"><div class="brandmark"><svg viewBox="0 0 48 48"><path d="M9 15.5h12l3.8 5H39a4 4 0 0 1 4 4v13a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-18a4 4 0 0 1 4-4Z"/><path d="M16 10h12a4 4 0 0 1 4 4v6H20l-4-5Z"/></svg></div><div><h1>Linux Archive Explorer</h1><p>Web Backup &amp; Restore for Linux</p></div></div><?php if ($error !== ''): ?><div class="login-error"><?= htmlspecialchars($error, ENT_QUOTES) ?></div><?php endif; ?><form method="post" autocomplete="on"><input type="hidden" name="csrf" value="<?= htmlspecialchars($csrf, ENT_QUOTES) ?>"><label for="username">Username</label><input class="textinput" id="username" name="username" title="Enter the Linux Archive Explorer login username" data-tip="Enter the Linux Archive Explorer login username" value="<?= htmlspecialchars($username, ENT_QUOTES) ?>" required autofocus autocomplete="username"><label for="password">Password</label><input class="textinput" id="password" name="password" title="Enter the Linux Archive Explorer login password" data-tip="Enter the Linux Archive Explorer login password" type="password" required autocomplete="current-password"><button class="primarybtn login-submit" type="submit" title="Sign in to Linux Archive Explorer">Sign In</button></form><div class="login-foot">Linux Archive Explorer v<?= LAE_VERSION ?></div></main></body></html>
