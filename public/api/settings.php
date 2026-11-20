<?php
declare(strict_types=1);
require dirname(__DIR__,2).'/app/bootstrap.php';
lae_require_auth();
try{
    $cfg=lae_config(); $current=lae_current_user();
    if(($_SERVER['REQUEST_METHOD']??'GET')==='GET'){
        lae_json(['ok'=>true,'settings'=>[
            'session_timeout'=>lae_session_timeout(),
            'default_format'=>(string)($cfg['application']['default_format']??'tar.gz'),
            'role'=>(string)($current['role']??'user'),
            'username'=>(string)($current['username']??''),
            'hostname'=>(string)(gethostname() ?: 'linux'),
        ]]);
    }
    lae_require_admin(); lae_require_csrf(); $in=lae_input_json();
    $timeout=(int)($in['session_timeout']??1800);$format=(string)($in['default_format']??'tar.gz');
    $data=lae_helper('archive','set-settings',['session_timeout'=>$timeout,'default_format'=>$format]);
    lae_json(['ok'=>true]+$data);
}catch(Throwable $e){lae_json(['ok'=>false,'error'=>$e->getMessage()],400);}
