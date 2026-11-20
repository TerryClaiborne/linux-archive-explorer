<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';
lae_start_session();
if (lae_logged_in()) lae_audit('auth.logout', ['ip' => lae_client_ip(), 'username' => (string)($_SESSION['lae_username'] ?? '')]);
lae_destroy_session();
header('Location: '.lae_base_url().'login.php', true, 302);
exit;
