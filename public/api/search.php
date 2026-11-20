<?php
declare(strict_types=1);
require dirname(__DIR__,2).'/app/bootstrap.php';
lae_require_auth();
try {
    $path = (string)($_GET['path'] ?? '/');
    $query = (string)($_GET['query'] ?? '');
    $data = lae_helper('archive', 'search-dir', ['path' => $path, 'query' => $query]);
    lae_json(['ok' => true] + $data);
} catch (Throwable $e) {
    lae_json(['ok' => false, 'error' => $e->getMessage()], 400);
}
