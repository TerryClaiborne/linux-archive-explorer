<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_auth(); lae_require_csrf();
try { $in=lae_input_json(); $data=lae_helper('archive','queue-archive',$in); $_SESSION['lae_jobs'][$data['job_id']]=time(); lae_json(['ok'=>true]+$data,202); }
catch(Throwable $e){ lae_json(['ok'=>false,'error'=>$e->getMessage()],400); }
