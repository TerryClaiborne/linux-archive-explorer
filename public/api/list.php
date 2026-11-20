<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_auth();
try { $path=(string)($_GET['path']??'/'); $dirs=isset($_GET['dirs'])&&$_GET['dirs']==='1'; $data=lae_helper('archive','list-dir',['path'=>$path,'dirs_only'=>$dirs]); lae_json(['ok'=>true]+$data); }
catch(Throwable $e){ lae_json(['ok'=>false,'error'=>$e->getMessage()],400); }
