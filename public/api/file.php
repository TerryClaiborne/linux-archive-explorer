<?php
declare(strict_types=1);
require dirname(__DIR__,2).'/app/bootstrap.php';
lae_require_auth();
try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'GET') {
        $action = (string)($_GET['action'] ?? 'properties');
        $path = (string)($_GET['path'] ?? '');
        if ($action === 'properties') {
            $data = lae_helper('archive','properties',['path'=>$path]);
            lae_json(['ok'=>true]+$data);
        }
        if ($action === 'transfer-target-info') {
            lae_require_admin();
            $data=lae_helper('archive','transfer-target-info',[
                'destination'=>(string)($_GET['destination']??''),
                'relative_path'=>(string)($_GET['relative_path']??''),
            ]);
            lae_json(['ok'=>true]+$data);
        }
        if ($action === 'transfer-destination-info') {
            lae_require_admin();
            $data = lae_helper('archive','transfer-destination-info',['path'=>$path]);
            lae_json(['ok'=>true]+$data);
        }
        if ($action === 'archive') {
            $mode = (string)($_GET['mode'] ?? 'info');
            if (!in_array($mode,['info','list','verify'],true)) throw new RuntimeException('Unsupported archive action.');
            $data = lae_helper('archive','archive-file',['path'=>$path,'mode'=>$mode,'limit'=>10000]);
            if ($mode === 'verify') lae_audit('archive.verify_requested',['username'=>(string)(lae_current_user()['username']??''),'path'=>$path]);
            lae_json(['ok'=>true]+$data);
        }
        if ($action === 'read-text') {
            lae_require_admin();
            $data = lae_helper('archive','read-text',['path'=>$path]);
            lae_json(['ok'=>true]+$data);
        }
        if ($action === 'walk') {
            $data = lae_helper('archive','walk-dir',['path'=>$path,'limit'=>20000]);
            lae_json(['ok'=>true]+$data);
        }
        throw new RuntimeException('Unsupported file query.');
    }
    lae_require_csrf();
    $in = lae_input_json();
    $action = (string)($in['action'] ?? '');
    if ($action === 'write-text') {
        lae_require_admin();
        $data = lae_helper('archive','write-text',[
            'path'=>(string)($in['path']??''),
            'content'=>(string)($in['content']??''),
            'expected_sha256'=>(string)($in['expected_sha256']??''),
            'line_ending'=>(string)($in['line_ending']??'lf'),
            'bom'=>(bool)($in['bom']??false),
            'confirmation_text'=>(string)($in['confirmation_text']??''),
        ]);
        lae_json(['ok'=>true]+$data);
    }
    if ($action === 'stage-download') {
        $data = lae_helper('archive','stage-download',['path'=>(string)($in['path']??'')]);
        $_SESSION['lae_jobs'][$data['job_id']] = time();
        lae_json(['ok'=>true]+$data,202);
    }
    if ($action === 'mkdir') {
        lae_require_admin();
        $data=lae_helper('archive','make-directory',[
            'destination'=>(string)($in['destination']??''),
            'relative_path'=>(string)($in['relative_path']??''),
            'confirmation_text'=>(string)($in['confirmation_text']??''),
        ]);
        lae_json(['ok'=>true]+$data);
    }
    if ($action === 'make-file') {
        lae_require_admin();
        $data=lae_helper('archive','make-file',[
            'destination'=>(string)($in['destination']??''),
            'name'=>(string)($in['name']??''),
            'confirmation_text'=>(string)($in['confirmation_text']??''),
        ]);
        lae_json(['ok'=>true]+$data);
    }
    if ($action === 'copy' || $action === 'move') {
        lae_require_admin();
        $data = lae_helper('archive','queue-file-op',[
            'op'=>$action,
            'sources'=>is_array($in['sources']??null)?$in['sources']:[],
            'destination'=>(string)($in['destination']??''),
            'confirmation_text'=>(string)($in['confirmation_text']??''),
            'conflict_action'=>(string)($in['conflict_action']??'error'),
        ]);
        $_SESSION['lae_jobs'][$data['job_id']] = time();
        lae_json(['ok'=>true]+$data,202);
    }
    if ($action === 'rename') {
        lae_require_admin();
        $data=lae_helper('archive','rename-path',['path'=>(string)($in['path']??''),'new_name'=>(string)($in['new_name']??''),'confirmation_text'=>(string)($in['confirmation_text']??'')]);
        lae_json(['ok'=>true]+$data);
    }
    if ($action === 'delete') {
        lae_require_admin();
        $data=lae_helper('archive','trash-path',['path'=>(string)($in['path']??''),'confirmation_text'=>(string)($in['confirmation_text']??'')]);
        lae_json(['ok'=>true]+$data);
    }
    throw new RuntimeException('Unsupported file action.');
} catch (Throwable $e) {
    lae_json(['ok'=>false,'error'=>$e->getMessage()],400);
}
