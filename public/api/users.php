<?php
declare(strict_types=1);
require dirname(__DIR__,2).'/app/bootstrap.php';
lae_require_admin();
try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        $data=lae_helper('archive','list-users'); $current=lae_current_user();
        lae_json(['ok'=>true,'current_username'=>(string)($current['username']??'')]+$data);
    }
    lae_require_csrf();
    $in=lae_input_json(); $action=(string)($in['action']??'');
    if($action==='save'){
        $username=(string)($in['username']??''); $role=(string)($in['role']??'user'); $enabled=($in['enabled']??true)===true; $password=(string)($in['password']??'');
        $current=lae_current_user();
        if($current&&hash_equals((string)$current['username'],$username)&&($role!=='admin'||!$enabled))throw new RuntimeException('You cannot disable or demote the account currently signed in.');
        $payload=['username'=>$username,'role'=>$role,'enabled'=>$enabled];
        if($password!==''){if($err=lae_validate_new_password($password))throw new RuntimeException($err);$payload['password_hash']=lae_hash_password($password);}
        $data=lae_helper('archive','upsert-user',$payload); lae_json(['ok'=>true]+$data);
    }
    if($action==='reset-password'){
        $username=(string)($in['username']??''); $new=(string)($in['new_password']??''); $confirm=(string)($in['confirm_password']??''); $current=lae_current_user();
        if($current&&hash_equals((string)$current['username'],$username))throw new RuntimeException('Use My Account to change the password for the account currently signed in.');
        if($new!==$confirm)throw new RuntimeException('New passwords do not match.');
        if($err=lae_validate_new_password($new))throw new RuntimeException($err);
        $data=lae_helper('archive','change-user-password',['username'=>$username,'password_hash'=>lae_hash_password($new)]);lae_json(['ok'=>true,'message'=>'Password reset successfully.']+$data);
    }
    if($action==='delete'){
        $username=(string)($in['username']??'');
        $current=lae_current_user(); if($current&&hash_equals((string)$current['username'],$username))throw new RuntimeException('You cannot delete the account currently signed in.');
        $data=lae_helper('archive','delete-user',['username'=>$username]);lae_json(['ok'=>true]+$data);
    }
    throw new RuntimeException('Unsupported user action.');
}catch(Throwable $e){lae_json(['ok'=>false,'error'=>$e->getMessage()],400);}
