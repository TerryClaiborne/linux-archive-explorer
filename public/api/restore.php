<?php
declare(strict_types=1); require dirname(__DIR__,2).'/app/bootstrap.php'; lae_require_admin(); lae_require_csrf();
try{$in=lae_input_json();$action=(string)($in['action']??'');
if($action==='inspect'){ $path=''; if(!empty($in['upload_id'])){$id=(string)$in['upload_id'];$path=(string)($_SESSION['lae_upload_paths'][$id]??'');if($path==='')throw new RuntimeException('Uploaded archive is not available.');}else{$path=(string)($in['linux_path']??'');} $data=lae_helper('restore','inspect',['path'=>$path]); $_SESSION['lae_restore_plans'][$data['plan_id']]=time(); lae_json(['ok'=>true]+$data); }
if($action==='queue'){ $plan=(string)($in['plan_id']??'');if(empty($_SESSION['lae_restore_plans'][$plan]))throw new RuntimeException('Restore preview is not associated with this login session.');$data=lae_helper('restore','queue-restore',['plan_id'=>$plan,'confirmed'=>($in['confirmed']??false)===true,'confirmation_text'=>(string)($in['confirmation_text']??'')]);$_SESSION['lae_jobs'][$data['job_id']]=time();lae_json(['ok'=>true]+$data,202); }
if($action==='rollback'){ $job=(string)($in['job_id']??'');$data=lae_helper('restore','queue-rollback',['job_id'=>$job,'confirmed'=>($in['confirmed']??false)===true,'confirmation_text'=>(string)($in['confirmation_text']??'')]);$_SESSION['lae_jobs'][$data['job_id']]=time();lae_json(['ok'=>true]+$data,202); }
if($action==='history'){lae_json(['ok'=>true]+lae_helper('restore','history'));}
if($action==='history-verify'){lae_json(['ok'=>true]+lae_helper('restore','history-verify',['job_id'=>(string)($in['job_id']??'')]));}
if($action==='history-protect'){lae_json(['ok'=>true]+lae_helper('restore','history-protect',['job_id'=>(string)($in['job_id']??''),'protected'=>($in['protected']??false)===true]));}
if($action==='history-delete'){lae_json(['ok'=>true]+lae_helper('restore','history-delete',['job_id'=>(string)($in['job_id']??''),'confirmation_text'=>(string)($in['confirmation_text']??'')]));}
throw new RuntimeException('Unsupported restore action.');
}catch(Throwable $e){lae_json(['ok'=>false,'error'=>$e->getMessage()],400);}
