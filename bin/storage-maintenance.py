#!/usr/bin/env python3
"""Read-only storage inventory or guarded cleanup. No user archive deletion."""
from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, ROLLBACK  # noqa: E402
from storage_policy import prune_installer, prune_safety_bundles, prune_spool, prune_finished_jobs, reset_legacy_ui, storage_report  # noqa: E402


def main():
    mode = sys.argv[1] if len(sys.argv) >= 2 else ''
    scope = sys.argv[2] if mode == '--clear-scope' and len(sys.argv) == 3 else None
    scopes = {'staging', 'uploads', 'jobs', 'trash', 'edits', 'restore', 'ui', 'installer'}
    if (mode not in ('--report', '--auto', '--reset', '--clear-scope') or
            (mode == '--clear-scope' and scope not in scopes) or
            (mode != '--clear-scope' and len(sys.argv) != 2)):
        raise SystemExit('Usage: storage-maintenance.py --report|--auto|--reset|--clear-scope SCOPE')
    if mode != '--report' and os.geteuid() != 0:
        raise SystemExit('Cleanup requires root')
    if not os.path.isdir(ROOT) or os.path.islink(ROOT) or not os.path.isdir(ROLLBACK) or os.path.islink(ROLLBACK):
        raise SystemExit('Refusing cleanup with unexpected application directories')
    before = storage_report(ROOT)
    if mode == '--report':
        print(json.dumps({'before': before}, indent=2)); return
    if os.path.lexists(os.path.join(ROOT, 'jobs', 'restore.lock')):
        raise SystemExit('STOP: Restore/rollback lock exists; cleanup refused')
    if mode in ('--reset', '--clear-scope'):
        jobs = Path(ROOT) / 'jobs'
        for job_file in jobs.glob('*.json'):
            try:
                job = json.loads(job_file.read_text(encoding='utf-8'))
            except (OSError, ValueError, TypeError):
                raise SystemExit('STOP: Unreadable job metadata; cleanup refused')
            if not isinstance(job, dict) or job.get('status') not in ('completed','warning','failed','cancelled','inspected'):
                raise SystemExit('STOP: An unfinished job exists; cleanup refused')
    # Root-owned rollback material cannot be pruned while a destructive job runs.
    restore_reset = None
    if mode == '--reset' or scope == 'restore':
        helper = str(Path(__file__).resolve().parent / 'restore-helper.py')
        proc = subprocess.run(['/usr/bin/python3', helper, '--prune-reset'], capture_output=True, text=True, timeout=180)
        if proc.returncode != 0:
            raise SystemExit('Restore safety cleanup failed; protected packages remain. ' + proc.stderr[-300:])
        restore_reset = json.loads(proc.stdout)
    # A scoped Clear does not unexpectedly prune unrelated recovery or workspaces.
    all_scopes = mode != '--clear-scope'
    result = {
        'installer': prune_installer(ROLLBACK, keep=0 if scope == 'installer' else 1) if all_scopes or scope == 'installer' else None,
        'safety': prune_safety_bundles(ROLLBACK, reset=(mode != '--auto'), target=scope) if all_scopes or scope in ('trash', 'edits') else None,
        'spool': prune_spool(ROOT, os.path.join(ROOT, 'jobs'), reset=(mode != '--auto'), target=scope) if all_scopes or scope in ('staging', 'uploads') else None,
        'restore_history': restore_reset,
        'jobs': prune_finished_jobs(ROOT, reset=(mode != '--auto')) if all_scopes or scope == 'jobs' else None,
        'legacy_ui': reset_legacy_ui(ROLLBACK) if all_scopes or scope == 'ui' else None,
    }
    print(json.dumps({'cleanup': result, 'before': before, 'after': storage_report(ROOT)}, indent=2))


if __name__ == '__main__':
    main()
