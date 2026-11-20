<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_auth();
try { $id=(string)($_GET['id']??''); if(empty($_SESSION['lae_jobs'][$id])) throw new RuntimeException('Job is not associated with this login session.'); $job=lae_job_status($id); lae_json(['ok'=>true,'job'=>lae_public_job($job)]); }
catch(Throwable $e){ lae_json(['ok'=>false,'error'=>$e->getMessage()],404); }
