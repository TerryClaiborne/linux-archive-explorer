<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_auth();
try{$data=lae_helper('archive','system-info');$data['php']=PHP_VERSION;$data['deployment']=(string)lae_config()['system']['deployment'];$data['https']=lae_is_secure_request();$data['base_url']=lae_base_url();$data['session_timeout']=lae_session_timeout();$data['current_user']=lae_current_user();lae_json(['ok'=>true,'system'=>$data]);}
catch(Throwable $e){lae_json(['ok'=>false,'error'=>$e->getMessage()],500);}
