<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_auth(false);
$id=(string)($_GET['id']??''); if(!lae_valid_job_id($id)||empty($_SESSION['lae_jobs'][$id])){http_response_code(404);exit;}
@set_time_limit(0); @ini_set('zlib.output_compression','0'); header('Content-Type: text/event-stream'); header('Cache-Control: no-store'); header('X-Accel-Buffering: no');
$path=rtrim((string)lae_config()['paths']['jobs'],'/').'/'.$id.'.json'; $last=''; $start=time(); $lastPing=0;
while(!connection_aborted() && time()-$start<55){ clearstatcache(true,$path); if(is_readable($path)){ $raw=(string)file_get_contents($path); if($raw!==$last){ $data=json_decode($raw,true); if(is_array($data)){ $public=lae_public_job($data); echo "event: status\n"; echo 'data: '.json_encode(['ok'=>true,'job'=>$public],JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE)."\n\n"; @ob_flush(); flush(); $last=$raw; if(in_array((string)($data['status']??''),['completed','warning','failed'],true)) break; } } }
  if(time()-$lastPing>=15){echo ": keepalive\n\n";@ob_flush();flush();$lastPing=time();} usleep(750000);
}
