<?php
declare(strict_types=1);
require dirname(__DIR__,2).'/app/bootstrap.php';
lae_require_auth();
lae_require_csrf();
try{
    $in=lae_input_json();
    $current=(string)($in['current_password']??'');
    $new=(string)($in['new_password']??'');
    $confirm=(string)($in['confirm_password']??'');
    $me=lae_current_user();
    if(!$me)throw new RuntimeException('Login session is unavailable.');
    $record=lae_find_user((string)$me['username']);
    if(!$record||!password_verify($current,(string)($record['password_hash']??'')))throw new RuntimeException('Current password is incorrect.');
    if($new!==$confirm)throw new RuntimeException('New passwords do not match.');
    if($err=lae_validate_new_password($new))throw new RuntimeException($err);
    if(hash_equals($current,$new))throw new RuntimeException('Choose a new password that is different from the current password.');
    $hash=lae_hash_password($new);
    lae_helper('archive','change-user-password',['username'=>(string)$me['username'],'password_hash'=>$hash]);
    lae_audit('auth.password_changed',['ip'=>lae_client_ip(),'username'=>(string)$me['username']]);
    session_regenerate_id(true);
    lae_json(['ok'=>true,'message'=>'Password changed successfully.']);
}catch(Throwable $e){lae_json(['ok'=>false,'error'=>$e->getMessage()],400);}
