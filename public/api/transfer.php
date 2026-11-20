<?php
declare(strict_types=1);
require dirname(__DIR__,2).'/app/bootstrap.php';
lae_require_admin();
$cfg=lae_config();$dir=rtrim((string)$cfg['paths']['uploads'],'/');$max=(int)$cfg['limits']['upload_max_bytes'];$chunkMax=max(1024*1024,(int)$cfg['limits']['upload_chunk_bytes']*2);
function transfer_meta(string $dir,string $id):string{if(!preg_match('/^[a-f0-9]{32}$/',$id))throw new RuntimeException('Invalid transfer id.');return $dir.'/'.$id.'.transfer.json';}
try{
$action=(string)($_GET['action']??'');
if($action==='start'){lae_require_csrf();$in=lae_input_json();$name=basename((string)($in['name']??''));$size=(int)($in['size']??-1);$dest=(string)($in['destination']??'');$relative=(string)($in['relative_path']??$name);if($name===''||preg_match('/[\x00-\x1F]/',$name))throw new RuntimeException('Invalid filename.');if($size<0||$size>$max)throw new RuntimeException('File exceeds the configured transfer limit.');lae_check_upload_space($dir,$size);$id=bin2hex(random_bytes(16));$confirmation=(string)($in['confirmation_text']??'');$meta=['id'=>$id,'name'=>$name,'size'=>$size,'received'=>0,'complete'=>false,'destination'=>$dest,'relative_path'=>$relative,'confirmation_text'=>$confirmation,'conflict_action'=>(string)($in['conflict_action']??'error'),'created_at'=>time()];$mp=transfer_meta($dir,$id);if(file_put_contents($mp,json_encode($meta,JSON_UNESCAPED_SLASHES),LOCK_EX)===false)throw new RuntimeException('Unable to create transfer metadata.');@chmod($mp,0640);$part=$dir.'/'.$id.'.transfer.part';$fh=fopen($part,'xb');if(!$fh){@unlink($mp);throw new RuntimeException('Unable to create transfer staging file.');}fclose($fh);@chmod($part,0640);$_SESSION['lae_transfers'][$id]=time();lae_json(['ok'=>true,'transfer_id'=>$id,'chunk_bytes'=>(int)$cfg['limits']['upload_chunk_bytes']]);}
if($action==='chunk'){
    $sent=(string)($_SERVER['HTTP_X_CSRF_TOKEN']??'');
    if($sent===''||!hash_equals(lae_csrf_token(),$sent))throw new RuntimeException('Invalid security token.');
    $id=(string)($_SERVER['HTTP_X_TRANSFER_ID']??'');
    if(empty($_SESSION['lae_transfers'][$id]))throw new RuntimeException('Transfer session not found.');
    $offset=(int)($_SERVER['HTTP_X_CHUNK_OFFSET']??-1);
    $mp=transfer_meta($dir,$id);
    $part=$dir.'/'.$id.'.transfer.part';
    $free=@disk_free_space($dir);$total=@disk_total_space($dir);
    if($free===false||$total===false||$free<lae_free_space_reserve((int)$total)+$chunkMax)throw new RuntimeException('Disk space is too low to continue uploading safely.');
    require_once dirname(__DIR__,2).'/app/chunk_writer.php';
    lae_json(lae_append_guarded_chunk($part,$mp,$offset,$chunkMax,'Transfer'));
}
if($action==='finish'){lae_require_csrf();$in=lae_input_json();$id=(string)($in['transfer_id']??'');if(empty($_SESSION['lae_transfers'][$id]))throw new RuntimeException('Transfer session not found.');$mp=transfer_meta($dir,$id);$meta=json_decode((string)file_get_contents($mp),true);if(!is_array($meta))throw new RuntimeException('Transfer metadata is invalid.');$part=$dir.'/'.$id.'.transfer.part';if(filesize($part)!==(int)$meta['size'])throw new RuntimeException('Transfer is incomplete.');$final=$dir.'/'.$id.'-'.$meta['name'];rename($part,$final);$data=lae_helper('archive','import-upload',['upload_path'=>$final,'destination'=>(string)$meta['destination'],'relative_path'=>(string)$meta['relative_path'],'confirmation_text'=>(string)($meta['confirmation_text']??''),'conflict_action'=>(string)($meta['conflict_action']??'error')]);$meta['complete']=true;$meta['completed_at']=time();file_put_contents($mp,json_encode($meta,JSON_UNESCAPED_SLASHES),LOCK_EX);unset($_SESSION['lae_transfers'][$id]);lae_json(['ok'=>true]+$data);}
throw new RuntimeException('Unsupported transfer action.');
}catch(Throwable $e){lae_json(['ok'=>false,'error'=>$e->getMessage()],400);}
