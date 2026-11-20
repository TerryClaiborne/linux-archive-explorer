<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_auth(false);
try{
$id=(string)($_GET['id']??''); if(empty($_SESSION['lae_jobs'][$id])) throw new RuntimeException('Archive job is not associated with this login session.'); $job=lae_job_status($id); if(!in_array((string)($job['kind']??''),['archive','download'],true)||!in_array($job['status']??'', ['completed','warning'],true)) throw new RuntimeException('File is not ready.');
$file=(string)($job['staged_path']??''); $staging=realpath((string)lae_config()['paths']['staging']); $real=realpath($file); if($staging===false||$real===false||!str_starts_with($real,rtrim($staging,'/').'/')||!is_file($real)) throw new RuntimeException('File is no longer available.');
$size=filesize($real); $start=0; $end=$size-1; $status=200; $range=(string)($_SERVER['HTTP_RANGE']??''); if($range!==''&&preg_match('/^bytes=(\d*)-(\d*)$/',$range,$m)){ if($m[1]===''&&$m[2]!==''){ $len=min((int)$m[2],$size);$start=$size-$len; } else { $start=$m[1]===''?0:(int)$m[1]; $end=$m[2]===''?$end:min((int)$m[2],$end);} if($start<0||$start>$end||$start>=$size){header('Content-Range: bytes */'.$size);http_response_code(416);exit;} $status=206; }
$name=(string)($job['filename']??basename($real)); $safe=str_replace(["\r","\n",'"'],'',$name); http_response_code($status); header('Content-Type: application/octet-stream'); header('Accept-Ranges: bytes'); header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff'); header('Content-Disposition: attachment; filename="'.$safe.'"; filename*=UTF-8\'\''.rawurlencode($name)); header('Content-Length: '.($end-$start+1)); if($status===206)header('Content-Range: bytes '.$start.'-'.$end.'/'.$size);
$fp=fopen($real,'rb'); if(!$fp)throw new RuntimeException('Unable to open archive.'); fseek($fp,$start); $remaining=$end-$start+1; while($remaining>0&&!feof($fp)&&!connection_aborted()){ $chunk=fread($fp,min(1024*1024,$remaining)); if($chunk===false||$chunk==='')break; echo $chunk; $remaining-=strlen($chunk); flush(); } fclose($fp);
// Never release staging on a partial/ranged/aborted response.
// The helper verifies the job and may unlink ONLY its temporary staged file.
if($status===200 && $remaining===0 && !connection_aborted()){
    try{lae_helper('archive','complete-download',['job_id'=>$id]);}
    catch(Throwable $cleanupError){error_log('Linux Archive Explorer staging release: '.$cleanupError->getMessage());}
}
exit;
}catch(Throwable $e){http_response_code(404);header('Content-Type:text/plain; charset=utf-8');echo $e->getMessage();}
