<?php
/** Administrator-only storage inventory and guarded cleanup. */
declare(strict_types=1);
require dirname(__DIR__,2).'/app/bootstrap.php';
lae_require_admin();
try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        lae_json(['ok'=>true] + lae_helper('archive', 'storage-report'));
    }
    lae_require_csrf();
    $input = lae_input_json();
    if (($input['action'] ?? '') === 'clear') {
        $scope = (string)($input['scope'] ?? '');
        $allowed = ['staging','uploads','jobs','trash','edits','restore','ui','installer'];
        if (!in_array($scope, $allowed, true) || ($input['confirmation'] ?? '') !== 'CLEAR ' . strtoupper($scope)) {
            throw new RuntimeException('Confirm the storage area using its exact CLEAR phrase.');
        }
        lae_json(['ok'=>true] + lae_helper('archive', 'storage-clear', ['scope'=>$scope,'confirmation'=>'CLEAR '.strtoupper($scope)]));
    }
    if (($input['action'] ?? '') !== 'reset' || ($input['confirmation'] ?? '') !== 'RESET') {
        throw new RuntimeException('Type RESET exactly to confirm cleanup.');
    }
    lae_json(['ok'=>true] + lae_helper('archive', 'storage-reset', ['confirmation'=>'RESET']));
} catch (Throwable $e) {
    lae_json(['ok'=>false, 'error'=>$e->getMessage()], 400);
}
