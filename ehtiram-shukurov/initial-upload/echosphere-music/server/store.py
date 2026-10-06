"""Durable queue. One separately running worker owns all expensive operations."""
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from .config import DATA, MAX_QUEUE

ACTIVE = ('queued', 'running')


@contextmanager
def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATA / 'jobs.sqlite3', timeout=20)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    try:
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def init():
    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS videos (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL,
          state TEXT NOT NULL, metadata TEXT, analysis TEXT,
          error TEXT, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id),
          kind TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL,
          payload TEXT NOT NULL, result TEXT, error TEXT,
          cancelled INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL,
          updated REAL NOT NULL, idempotency TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY, heartbeat REAL);
        ''')


def decode(row):
    if row is None:
        return None
    out = dict(row)
    for key in ('metadata', 'analysis', 'payload', 'result'):
        if key in out and out[key] is not None:
            out[key] = json.loads(out[key])
    return out


def get(table, id):
    assert table in ('jobs', 'videos')
    with connect() as db:
        return decode(db.execute(f'SELECT * FROM {table} WHERE id=?', (id,)).fetchone())


def update(table, id, **fields):
    allowed = {'state', 'phase', 'metadata', 'analysis', 'payload', 'result', 'error', 'cancelled', 'updated'}
    assert table in ('jobs', 'videos') and fields.keys() <= allowed
    if table == 'jobs':
        fields['updated'] = time.time()
    values = [json.dumps(v, allow_nan=False) if isinstance(v, (dict, list)) else v for v in fields.values()]
    with connect() as db:
        db.execute(f'UPDATE {table} SET '+','.join(f'{k}=?' for k in fields)+' WHERE id=?', values+[id])


def enqueue(video_id, kind, payload, idempotency=None):
    now, id = time.time(), uuid.uuid4().hex
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if idempotency:
            old = decode(db.execute('SELECT * FROM jobs WHERE idempotency=?', (idempotency,)).fetchone())
            if old:
                if old['video_id'] != video_id or old['kind'] != kind or old['payload'] != payload:
                    raise ValueError('This idempotency key was already used for different input.')
                return old
        if db.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0] >= MAX_QUEUE:
            raise ValueError('The queue is full. Wait for a job to finish and retry.')
        if kind=='analysis' and db.execute("SELECT 1 FROM jobs WHERE video_id=? AND kind='analysis' AND state IN ('queued','running')",(video_id,)).fetchone():
            raise ValueError('An analysis is already queued for this video.')
        db.execute('INSERT INTO jobs (id,video_id,kind,state,phase,payload,created,updated,idempotency) VALUES (?,?,?,?,?,?,?,?,?)',
                   (id, video_id, kind, 'queued', 'Queued', json.dumps(payload), now, now, idempotency))
    return get('jobs', id)


def claim():
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
        if not row:
            return None
        db.execute("UPDATE jobs SET state='running',updated=? WHERE id=?", (time.time(), row['id']))
        return decode(row)


def heartbeat():
    with connect() as db:
        db.execute('INSERT OR REPLACE INTO worker (id,heartbeat) VALUES (1,?)', (time.time(),))


def worker_online():
    with connect() as db:
        row = db.execute('SELECT heartbeat FROM worker WHERE id=1').fetchone()
        return bool(row and time.time()-row[0] < 15)


def recover():
    # The exclusive OS lock ensures these belong to a stopped process.
    with connect() as db:
        db.execute("UPDATE videos SET state='failed',error='Import interrupted. Upload the video again.' WHERE state='importing'")
        db.execute("UPDATE jobs SET state='failed',phase='Interrupted',error='Worker stopped during processing. Submit a new job.',updated=? WHERE state='running'", (time.time(),))
