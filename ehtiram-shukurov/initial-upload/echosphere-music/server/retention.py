"""Storage accounting, quotas and automatic cleanup that never touch active work."""
import os
import shutil
import time
from . import store
from .config import DATA, MAX_STORAGE_BYTES, RETENTION_HOURS

ORPHAN_GRACE = 3600  # A folder can briefly exist before its database row does.


def folder_bytes(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def usage_bytes():
    return folder_bytes(DATA / 'videos') + folder_bytes(DATA / 'jobs')


def purge_video(video_id):
    """Remove a video, its analyses and soundtracks. Refuses if any job is active."""
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        rows = db.execute('SELECT id,state FROM jobs WHERE video_id=?', (video_id,)).fetchall()
        if any(r['state'] in store.ACTIVE for r in rows):
            return False
        db.execute('DELETE FROM jobs WHERE video_id=?', (video_id,))
        db.execute('DELETE FROM videos WHERE id=?', (video_id,))
    for row in rows:
        shutil.rmtree(DATA / 'jobs' / row['id'], ignore_errors=True)
    shutil.rmtree(DATA / 'videos' / video_id, ignore_errors=True)
    return True


def sweep(now=None):
    """Delete expired videos and orphaned folders. Returns the number of videos removed."""
    now = now or time.time()
    removed = 0
    if RETENTION_HOURS > 0:
        with store.connect() as db:
            rows = db.execute('''SELECT v.id, MAX(v.created, COALESCE(MAX(j.updated), 0)) AS last
                                 FROM videos v LEFT JOIN jobs j ON j.video_id=v.id GROUP BY v.id''').fetchall()
        for row in rows:
            if now - row['last'] > RETENTION_HOURS * 3600 and purge_video(row['id']):
                removed += 1
    with store.connect() as db:
        videos = {r[0] for r in db.execute('SELECT id FROM videos')}
        jobs = {r[0] for r in db.execute('SELECT id FROM jobs')}
    for parent, known in ((DATA / 'videos', videos), (DATA / 'jobs', jobs)):
        if parent.is_dir():
            for child in parent.iterdir():
                if child.name not in known and now - child.stat().st_mtime > ORPHAN_GRACE:
                    shutil.rmtree(child, ignore_errors=True)
    return removed


def has_room(needed):
    """True if `needed` more bytes fit the quota, after clearing expired items."""
    if not MAX_STORAGE_BYTES:
        return True
    if usage_bytes() + needed <= MAX_STORAGE_BYTES:
        return True
    sweep()
    return usage_bytes() + needed <= MAX_STORAGE_BYTES
