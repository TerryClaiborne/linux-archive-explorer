<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_auth();
$cfg=lae_config(); $dir=rtrim((string)$cfg['paths']['uploads'],'/'); $max=(int)$cfg['limits']['upload_max_bytes']; $chunkMax=max(1024*1024,(int)$cfg['limits']['upload_chunk_bytes']*2); if(!is_dir($dir)||!is_writable($dir))lae_json(['ok'=>false,'error'=>'Upload staging directory is unavailable. Run installer Verify/Repair.'],503);
function upload_meta(string $dir,string $id):string{if(!preg_match('/^[a-f0-9]{32}$/',$id))throw new RuntimeException('Invalid upload id.');return $dir.'/'.$id.'.json';}
try{
$action=(string)($_GET['action']??'');
if($action==='start'){lae_require_csrf();$in=lae_input_json();$name=basename((string)($in['name']??''));$size=(int)($in['size']??0);if($name===''||preg_match('/[\x00-\x1F]/',$name))throw new RuntimeException('Invalid archive filename.');if($size<=0||$size>$max)throw new RuntimeException('Archive is empty or exceeds the configured upload limit.');if(!preg_match('/\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.zst|tzst|zip)$/i',$name))throw new RuntimeException('Choose a supported tar or ZIP archive.');if(!is_dir($dir)||!is_writable($dir))throw new RuntimeException('Upload staging directory is not writable. Run installer Verify/Repair.');lae_check_upload_space($dir,$size);$id=bin2hex(random_bytes(16));$meta=['id'=>$id,'name'=>$name,'size'=>$size,'received'=>0,'complete'=>false,'created_at'=>time()];$mp=upload_meta($dir,$id);if(file_put_contents($mp,json_encode($meta,JSON_UNESCAPED_SLASHES),LOCK_EX)===false)throw new RuntimeException('Unable to create upload metadata.');@chmod($mp,0640);$part=$dir.'/'.$id.'.part';$fh=fopen($part,'xb');if(!$fh){@unlink($mp);throw new RuntimeException('Unable to create upload staging file.');}fclose($fh);@chmod($part,0640);$_SESSION['lae_uploads'][$id]=time();lae_json(['ok'=>true,'upload_id'=>$id,'chunk_bytes'=>(int)$cfg['limits']['upload_chunk_bytes']]);}
if($action==='chunk'){
    $sent=(string)($_SERVER['HTTP_X_CSRF_TOKEN']??'');
    if($sent===''||!hash_equals(lae_csrf_token(),$sent))throw new RuntimeException('Invalid security token.');
    $id=(string)($_SERVER['HTTP_X_UPLOAD_ID']??'');
    if(empty($_SESSION['lae_uploads'][$id]))throw new RuntimeException('Upload session not found.');
    $offset=(int)($_SERVER['HTTP_X_CHUNK_OFFSET']??-1);
    $mp=upload_meta($dir,$id);
    $part=$dir.'/'.$id.'.part';
    $free=@disk_free_space($dir);$total=@disk_total_space($dir);
    if($free===false||$total===false||$free<lae_free_space_reserve((int)$total)+$chunkMax)throw new RuntimeException('Disk space is too low to continue uploading safely.');
    require_once dirname(__DIR__,2).'/app/chunk_writer.php';
    lae_json(lae_append_guarded_chunk($part,$mp,$offset,$chunkMax,'Upload'));
}
if($action==='finish'){lae_require_csrf();$in=lae_input_json();$id=(string)($in['upload_id']??'');if(empty($_SESSION['lae_uploads'][$id]))throw new RuntimeException('Upload session not found.');$mp=upload_meta($dir,$id);$meta=json_decode((string)file_get_contents($mp),true);if(!is_array($meta))throw new RuntimeException('Upload metadata is invalid.');$part=$dir.'/'.$id.'.part';if(filesize($part)!==(int)$meta['size'])throw new RuntimeException('Upload is incomplete.');$safe=preg_replace('/[^A-Za-z0-9._ -]+/u','_',basename((string)$meta['name']));$final=$dir.'/'.$id.'-'.$safe;rename($part,$final);$meta['complete']=true;$meta['path']=$final;$meta['sha256']=hash_file('sha256',$final);$meta['completed_at']=time();file_put_contents($mp,json_encode($meta,JSON_UNESCAPED_SLASHES),LOCK_EX);$_SESSION['lae_upload_paths'][$id]=$final;lae_json(['ok'=>true,'upload_id'=>$id,'name'=>$meta['name'],'size'=>$meta['size'],'sha256'=>$meta['sha256']]); }
if($action==='discard'){
    lae_require_csrf();
    $in=lae_input_json();$id=(string)($in['upload_id']??'');
    if(empty($_SESSION['lae_uploads'][$id]))throw new RuntimeException('Upload session not found.');
    $mp=upload_meta($dir,$id);
    $meta=is_file($mp)?json_decode((string)file_get_contents($mp),true):null;
    if(is_array($meta) && ($meta['id']??'')===$id){
        $path=(string)($meta['path']??'');
        if($path!=='' && dirname($path)===$dir && str_starts_with(basename($path),$id.'-') && !is_link($path) && is_file($path)){
            // Do not release an archive still being read by an active restore.
            $jobsDir=rtrim((string)$cfg['paths']['jobs'],'/');$inUse=false;
            foreach(glob($jobsDir.'/*.json')?:[] as $jobFile){
                $job=json_decode((string)@file_get_contents($jobFile),true);
                if(is_array($job)&&($job['kind']??null)==='restore'&&($job['archive_path']??null)===$path && !in_array(($job['status']??''),['completed','failed'],true)){$inUse=true;break;}
            }
            if($inUse)throw new RuntimeException('The archive is still needed by an active restore.');
            unlink($path);
        }
        $part=$dir.'/'.$id.'.part';if(!is_link($part)&&is_file($part))unlink($part);
    }
    if(is_file($mp)&&!is_link($mp))unlink($mp);
    unset($_SESSION['lae_uploads'][$id],$_SESSION['lae_upload_paths'][$id]);
    lae_json(['ok'=>true,'discarded'=>true]);
}
throw new RuntimeException('Unsupported upload action.');
}catch(Throwable $e){lae_json(['ok'=>false,'error'=>$e->getMessage()],400);}
