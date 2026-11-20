<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_auth();
try { $id=(string)($_GET['id']??''); if(empty($_SESSION['lae_jobs'][$id])) throw new RuntimeException('Job is not associated with this login session.'); $data=lae_helper('archive','list-archive',['job_id'=>$id,'limit'=>10000]); lae_json(['ok'=>true]+$data); }
catch(Throwable $e){ lae_json(['ok'=>false,'error'=>$e->getMessage()],400); }
