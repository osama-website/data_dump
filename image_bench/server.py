#!/usr/bin/env python3
"""
image_bench server — merge / split / suggest UI for albums under
    /old_Users/sarmad/Osama/thumbnails/<year>/<event>/<camera>/...

Run AFTER build_index.py has produced:
    image_bench/images.json
    image_bench/album_index.json
    image_bench/suggestions.json
    image_bench/embeddings.npy        (not needed unless ?with_emb)
    image_bench/album_means.npy       (not needed at runtime)

Port: $PORT or 8095.

Persisted state (mutated by /api/merge, /api/split, /api/undo):
    image_bench/state.json
      { 'overrides': {image_path: current_album_id, ...},
        'history':   [action, action, ...],
        'split_counters': {original_album_id: int} }

The 'overrides' table is the source of truth for an image's CURRENT album.
For every image not in overrides, current album == original album (from
images.json).  This keeps the file small.
"""

import http.server, socketserver, json, os, threading, urllib.parse, time, sys, posixpath
import base64, hashlib, subprocess, re
from pathlib import Path
from collections import defaultdict
import mimetypes
import numpy as np
try:
    from PIL import Image
except ImportError:
    Image = None

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent                              # /old_Users/sarmad/Osama
THUMBS_DIR = ROOT / 'thumbnails'

IMAGES_FILE      = BASE / 'images.json'
ALBUM_INDEX_FILE = BASE / 'album_index.json'
SUGGESTIONS_FILE = BASE / 'suggestions.json'
EMBEDDINGS_FILE  = BASE / 'embeddings.npy'
ALBUM_MEANS_FILE = BASE / 'album_means.npy'
STATE_FILE       = BASE / 'state.json'
API_KEYS_FILE    = ROOT / '.api.json'
COLLAGE_CACHE    = BASE / 'collage_cache'
COLLAGE_CACHE.mkdir(exist_ok=True)
GEMINI_MODEL = 'gemini-3.5-flash'   # same as tagger
JANUS_ENDPOINT_FILE = ROOT / 'janus_endpoint.txt'
JANUS_JOB_SCRIPT    = ROOT / 'janus_server_job.sh'
SGE_SOURCE = '. /opt/sge/default/common/settings.sh 2>/dev/null;'

# Small Google-Photos-style keyword pool for Janus free-text → tag extraction
JANUS_TAG_POOL = (
    'Selfies Portrait Group Family Friends Children Baby Wedding Birthday Party '
    'Graduation Concert Holiday Travel City Architecture Landmark Museum Art '
    'Beach Ocean Lake River Mountains Hiking Camping Forest Desert Snow Nature '
    'Garden Flowers Sunset Sunrise Night Fireworks Food Drinks Restaurant Coffee '
    'Animals Pets Cats Dogs Birds Sports Fitness Cycling Cars Boats Aerial Crowd '
    'Street Selfie Documents Screenshot Whiteboard Vintage Film'
).split()

PORT = int(os.environ.get('PORT', '8095'))

# ── runtime state ──────────────────────────────────────────────────────────
_lock = threading.Lock()
_images = []          # [{p, a, d}, ...]
_path_to_idx = {}     # image_path -> index in _images
_orig_album = {}      # image_path -> original album id
_overrides = {}       # image_path -> current album id (only differences)
_history  = []        # action records (for undo)
_split_counters = {}  # original_album_id -> next split index
_album_meta = {}      # original album id -> {n, date_min, date_max, cover}
_suggestions = {'merge': [], 'split': []}
_flagged = set()      # image_paths flagged for deletion
_emb = None           # (N, 512) float32, L2-normalized; row-aligned with _images
_alb_means = None     # (A, 512) float32, mean per ORIGINAL album, row=idx in _album_meta
_orig_alb_ids = []    # parallel list of original album ids (means row index)
_orig_alb_to_idx = {} # original album id -> row in _alb_means
_album_meta_user = {} # album_id -> {name, year, location, tags, notes, suggested_at}
_gemini_key_idx = 0


def log(*args):
    print(time.strftime('[%H:%M:%S]'), *args, flush=True, file=sys.stderr)


def load_all():
    global _images, _path_to_idx, _orig_album, _album_meta, _suggestions, _emb
    log('loading images.json ...')
    with open(IMAGES_FILE) as f:
        _images = json.load(f)
    _path_to_idx = {im['p']: i for i, im in enumerate(_images)}
    _orig_album = {im['p']: im['a'] for im in _images}
    log(f'  {len(_images)} images, {len(set(_orig_album.values()))} albums')

    log('loading album_index.json ...')
    with open(ALBUM_INDEX_FILE) as f:
        _album_meta = json.load(f)

    if EMBEDDINGS_FILE.exists():
        log(f'mmap embeddings ({EMBEDDINGS_FILE.stat().st_size/1e6:.0f} MB) ...')
        _emb = np.load(EMBEDDINGS_FILE, mmap_mode='r')
        log(f'  embeddings shape={_emb.shape} dtype={_emb.dtype}')

    if ALBUM_MEANS_FILE.exists():
        global _alb_means, _orig_alb_ids, _orig_alb_to_idx
        # rows correspond to sorted(album_meta) — same convention as build_index
        _orig_alb_ids = sorted(_album_meta.keys())
        _orig_alb_to_idx = {a: i for i, a in enumerate(_orig_alb_ids)}
        _alb_means = np.load(ALBUM_MEANS_FILE).astype(np.float32)
        log(f'  album_means shape={_alb_means.shape} (in-mem)')

    if SUGGESTIONS_FILE.exists():
        with open(SUGGESTIONS_FILE) as f:
            _suggestions = json.load(f)
        log(f'  suggestions: merge={len(_suggestions.get("merge", []))}'
            f'  split={len(_suggestions.get("split", []))}')

    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            st = json.load(f)
        global _overrides, _history, _split_counters, _flagged, _album_meta_user
        _overrides      = st.get('overrides', {})
        _history        = st.get('history', [])
        _split_counters = st.get('split_counters', {})
        _flagged        = set(st.get('flagged', []))
        _album_meta_user = st.get('album_metadata', {})
        log(f'  state: {len(_overrides)} overrides, {len(_history)} history, '
            f'{len(_flagged)} flagged, {len(_album_meta_user)} album-meta entries')


def save_state():
    tmp = STATE_FILE.with_suffix('.tmp')
    with open(tmp, 'w') as f:
        json.dump({
            'overrides': _overrides,
            'history':   _history,
            'split_counters': _split_counters,
            'flagged':   sorted(_flagged),
            'album_metadata': _album_meta_user,
        }, f)
    os.replace(tmp, STATE_FILE)


def current_album(path):
    return _overrides.get(path, _orig_album.get(path))


def root_of(album_id):
    """Strip any trailing _<N> we added so we can find the original 'family'."""
    base = album_id
    while True:
        i = base.rfind('_')
        if i < 0:
            return base
        suf = base[i + 1:]
        if suf.isdigit():
            base = base[:i]
        else:
            return base


def next_split_id(album_id):
    root = root_of(album_id)
    _split_counters[root] = _split_counters.get(root, 0) + 1
    return f'{root}_{_split_counters[root]}'


def rebuild_current_album_index():
    """Return dict: current_album_id -> {n, date_min, date_max, cover, n_flagged}."""
    by_alb = defaultdict(list)
    for im in _images:
        ca = _overrides.get(im['p'], im['a'])
        by_alb[ca].append(im)
    out = {}
    for alb, ims in by_alb.items():
        ims_sorted = sorted(ims, key=lambda x: x['d'] or 'zzz')
        ds = [x['d'] for x in ims_sorted if x['d']]
        n_flagged = sum(1 for x in ims if x['p'] in _flagged)
        out[alb] = {
            'n': len(ims),
            'date_min': ds[0] if ds else '',
            'date_max': ds[-1] if ds else '',
            'cover': ims_sorted[0]['p'],
            'orig_root': root_of(alb),
            'year': (alb.split('/', 1)[0] if '/' in alb else alb),
            'n_flagged': n_flagged,
        }
    return out


# ── Collage + Gemini helpers ──────────────────────────────────────────────
def _album_collage_path(album_id):
    h = hashlib.md5(album_id.encode()).hexdigest()[:16]
    return COLLAGE_CACHE / f'{h}.jpg'

def get_collage(album_id, force=False):
    """4x4 JPEG collage of the album's most-central photos. Cached by md5(id)."""
    if Image is None:
        return None
    p = _album_collage_path(album_id)
    if p.exists() and not force:
        return p
    # gather paths for this album
    with _lock:
        ims = [im for im in _images if current_album(im['p']) == album_id]
    if not ims:
        return None
    # pick most-central photos by cos to album mean (fallback: first N)
    if _emb is not None:
        rows = [ _path_to_idx[im['p']] for im in ims if im['p'] in _path_to_idx ]
        if rows:
            sub = _emb[rows]
            c = sub.mean(0); n = np.linalg.norm(c)
            if n > 0:
                c = c / n
                sims = (sub @ c)
                order = np.argsort(-sims)
                ims = [ims[i] for i in order[:16]]
    ims = ims[:16]
    # 4x4 grid, 200px tiles → 800x800 canvas
    TILE = 200; GRID = 4
    canvas = Image.new('RGB', (TILE * GRID, TILE * GRID), (10, 10, 10))
    for i, im in enumerate(ims[:GRID * GRID]):
        fp = ROOT / im['p']
        if not fp.is_file():
            continue
        try:
            with Image.open(fp) as src:
                src.thumbnail((TILE, TILE), Image.LANCZOS)
                x = (i % GRID) * TILE + (TILE - src.width) // 2
                y = (i // GRID) * TILE + (TILE - src.height) // 2
                canvas.paste(src, (x, y))
        except Exception as e:
            log(f'  collage tile fail {fp}: {e}')
    canvas.save(p, 'JPEG', quality=82, optimize=True)
    return p


def load_gemini_keys():
    if API_KEYS_FILE.exists():
        with open(API_KEYS_FILE) as f:
            return json.load(f).get('keys', [])
    return []


def call_gemini(prompt, img_b64):
    """Gemini 3.5 with rotating keys + thinking_level=HIGH. Returns parsed
    JSON dict or {'error': ...}."""
    global _gemini_key_idx
    keys = load_gemini_keys()
    if not keys:
        return {'error': 'no Gemini API keys configured (~/Osama/.api.json)'}
    payload = json.dumps({
        'contents': [{'parts': [
            {'inline_data': {'mime_type': 'image/jpeg', 'data': img_b64}},
            {'text': prompt},
        ]}],
        'generationConfig': {
            'temperature': 0.2,
            'maxOutputTokens': 2048,
            'thinkingConfig': {'thinkingLevel': 'HIGH'},
        },
    })
    url = (f'https://generativelanguage.googleapis.com/v1beta/models/'
           f'{GEMINI_MODEL}:generateContent')
    last = 'unknown'
    for attempt in range(len(keys)):
        key = keys[(_gemini_key_idx + attempt) % len(keys)]
        try:
            res = subprocess.run(
                ['curl', '-s', '-X', 'POST', url,
                 '-H', f'x-goog-api-key: {key}',
                 '-H', 'Content-Type: application/json',
                 '--data-binary', '@-'],
                input=payload, capture_output=True, text=True, timeout=60)
            data = json.loads(res.stdout) if res.stdout.strip() else {}
            if 'candidates' not in data:
                last = data.get('error', {}).get('message', res.stdout[:200])
                if any(w in last.lower() for w in ('quota','rate','exhaust','limit','permission','invalid')):
                    continue
                return {'error': f'Gemini: {last}'}
            parts = data['candidates'][0].get('content', {}).get('parts', [])
            text = next((p['text'] for p in parts if 'text' in p), '').strip()
            if not text:
                last = 'empty response'; continue
            _gemini_key_idx = (_gemini_key_idx + attempt) % len(keys)
            text = re.sub(r'^```[a-z]*\n?', '', text)
            text = re.sub(r'\n?```$', '', text).strip()
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return {'error': f'non-JSON: {text[:200]}'}
        except Exception as e:
            last = str(e); continue
    return {'error': f'Gemini (all {len(keys)} keys failed): {last}'}


def janus_endpoint():
    if JANUS_ENDPOINT_FILE.exists():
        ep = JANUS_ENDPOINT_FILE.read_text().strip()
        if ep:
            return ep if ep.startswith('http') else f'http://{ep}'
    return ''


def janus_endpoint_healthy():
    ep = janus_endpoint()
    if not ep:
        return False, ''
    url = ep.rstrip('/') + '/health'
    try:
        r = subprocess.run(['curl', '-sf', '-m', '4', url],
                           capture_output=True, text=True, timeout=6)
        ok = r.returncode == 0 and 'ok' in r.stdout.lower()
        return ok, ep
    except Exception:
        return False, ep


def janus_job_state():
    """Returns 'r' (running), 'qw' (queued), or '' (none) for janus_server."""
    try:
        out = subprocess.run(
            ['bash', '-lc', f'{SGE_SOURCE} qstat -u sarmad'],
            capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return ''
    for line in out.splitlines():
        if 'janus_server' in line:
            cols = line.split()
            if len(cols) >= 5:
                return cols[4]   # state column
    return ''


def call_janus(img_b64, prompt=None):
    """POST collage to janus_server /describe → returns free-text description
    (or dict with 'error')."""
    ok, ep = janus_endpoint_healthy()
    if not ok:
        return {'error': 'Janus endpoint not ready'}
    url = ep.rstrip('/') + '/describe'
    payload = json.dumps({'image_b64': img_b64, **({'prompt': prompt} if prompt else {})})
    try:
        r = subprocess.run(
            ['curl', '-s', '-X', 'POST', url,
             '-H', 'Content-Type: application/json',
             '--data-binary', '@-'],
            input=payload, capture_output=True, text=True, timeout=120)
        if not r.stdout.strip():
            return {'error': f'Janus no response: {r.stderr[:160]}'}
        data = json.loads(r.stdout)
        if 'error' in data:
            return {'error': f'Janus: {data["error"]}'}
        return data
    except Exception as e:
        return {'error': f'Janus call failed: {e}'}


def tags_from_text(text, limit=6):
    """Extract Google-Photos-style tags from Janus's free-text description."""
    if not text:
        return []
    low = text.lower()
    found = []
    for t in JANUS_TAG_POOL:
        if t not in found and re.search(r'\b' + re.escape(t.lower()) + r's?\b', low):
            found.append(t)
            if len(found) >= limit:
                break
    return found


def build_suggest_prompt(album_id, existing, n_images):
    parts = album_id.split('/')
    year   = parts[0] if len(parts) > 0 else ''
    event  = parts[1] if len(parts) > 1 else ''
    camera = parts[2] if len(parts) > 2 else ''
    known = []
    if existing.get('name'):     known.append(f"User-set name: {existing['name']}")
    if existing.get('year'):     known.append(f"User-set year: {existing['year']}")
    if existing.get('location'): known.append(f"User-set location: {existing['location']}")
    if existing.get('tags'):     known.append(f"User-set tags: {existing['tags']}")
    if existing.get('notes'):    known.append(f"User notes: {existing['notes']}")
    known_block = '\n'.join(known) if known else '(none yet)'
    return (
        f'Look at this 4x4 collage of {min(n_images,16)} representative photos '
        f'from a photo album.\n'
        f'Original folder name: "{event}"  (camera: {camera}, folder year: {year}, '
        f'{n_images} total photos)\n\n'
        f'User-confirmed info (do NOT contradict, only supplement):\n{known_block}\n\n'
        f'Return ONLY a JSON object (no markdown fences, no explanation) with '
        f'EXACTLY these keys:\n'
        f'{{"name":"short descriptive title <60 chars",'
        f'"year":"YYYY or empty if unsure",'
        f'"location":"City, Country or short place name",'
        f'"tags":["2-6 concise tags"],'
        f'"notes":"one-sentence description under 120 chars"}}\n\n'
        f'Rules:\n'
        f'- "name" should describe the EVENT or scene, not the camera or filename\n'
        f'- prefer concrete place names visible in the images over generic ones\n'
        f'- tags: Google-Photos-style nouns (e.g., Hiking, Wedding, Beach, Children)\n'
        f'- if you cannot tell, return empty string for that field rather than guessing'
    )


# ── HTTP handler ───────────────────────────────────────────────────────────
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence default logging

    # ----- helpers -----
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(n) if n > 0 else b'{}'
        try:
            return json.loads(raw.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            return {}

    def _serve_static(self, fname):
        p = BASE / fname
        if not p.is_file():
            self.send_error(404); return
        ctype = mimetypes.guess_type(str(p))[0] or 'application/octet-stream'
        data = p.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        # never let the browser keep an old build of the SPA shell
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.end_headers()
        self.wfile.write(data)

    def _serve_thumb(self, rel):
        # rel like 'thumbnails/2023/.../foo.jpg'
        rel = urllib.parse.unquote(rel)
        if '..' in rel.split('/') or not rel.startswith('thumbnails/'):
            self.send_error(400); return
        p = ROOT / rel
        if not p.is_file():
            self.send_error(404); return
        ctype = mimetypes.guess_type(str(p))[0] or 'image/jpeg'
        data = p.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'public, max-age=3600')
        self.end_headers()
        self.wfile.write(data)

    # ----- routes -----
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        path = u.path
        qs   = urllib.parse.parse_qs(u.query)
        if path == '/':
            return self._serve_static('index.html')
        if path == '/index.html' or path == '/main.js' or path == '/style.css':
            return self._serve_static(path.lstrip('/'))
        if path == '/api/albums':
            return self.api_albums(qs)
        if path == '/api/album':
            return self.api_album(qs)
        if path == '/api/suggestions':
            return self.api_suggestions(qs)
        if path == '/api/stats':
            return self.api_stats()
        if path == '/api/years':
            return self.api_years()
        if path == '/api/cameras':
            return self.api_cameras()
        if path == '/api/export':
            return self.api_export()
        if path == '/api/flagged':
            return self.api_flagged_list()
        if path == '/api/photo_neighbors':
            return self.api_photo_neighbors(qs)
        if path == '/api/group_candidates':
            return self.api_group_candidates(qs)
        if path == '/api/album_meta':
            return self.api_album_meta_get(qs)
        if path == '/api/album_collage':
            return self.api_album_collage(qs)
        if path == '/api/janus_status':
            return self.api_janus_status()
        if path == '/api/thumb':
            return self._serve_thumb(qs.get('p', [''])[0])
        if path.startswith('/thumbnails/'):
            return self._serve_thumb(path.lstrip('/'))
        self.send_error(404)

    def do_POST(self):
        if self.path == '/api/merge':  return self.api_merge()
        if self.path == '/api/split':  return self.api_split()
        if self.path == '/api/undo':   return self.api_undo()
        if self.path == '/api/flag':   return self.api_flag()
        if self.path == '/api/album_meta':           return self.api_album_meta_post()
        if self.path == '/api/suggest_album_meta':   return self.api_suggest_album_meta()
        if self.path == '/api/photo_group_neighbors': return self.api_photo_group_neighbors()
        if self.path == '/api/reset':                return self.api_reset()
        if self.path == '/api/janus_start':           return self.api_janus_start()
        if self.path == '/api/janus_stop':            return self.api_janus_stop()
        if self.path == '/api/suggest_album_meta_janus': return self.api_suggest_album_meta_janus()
        self.send_error(404)

    # ----- handlers -----
    def api_stats(self):
        with _lock:
            cur = rebuild_current_album_index()
        self._json({
            'n_images':  len(_images),
            'n_albums_orig': len(set(_orig_album.values())),
            'n_albums_current': len(cur),
            'n_overrides': len(_overrides),
            'n_history':   len(_history),
            'n_flagged':   len(_flagged),
            'suggestions_built_at': _suggestions.get('built_at', ''),
        })

    def api_years(self):
        with _lock:
            cur = rebuild_current_album_index()
        by_year = defaultdict(lambda: {'albums': 0, 'images': 0, 'flagged': 0})
        for alb, meta in cur.items():
            y = meta['year']
            by_year[y]['albums'] += 1
            by_year[y]['images'] += meta['n']
            by_year[y]['flagged'] += meta['n_flagged']
        rows = [{'year': y, **v} for y, v in by_year.items()]
        rows.sort(key=lambda r: r['year'])
        self._json({'years': rows})

    def api_cameras(self):
        with _lock:
            cur = rebuild_current_album_index()
        by_cam = defaultdict(lambda: {'albums': 0, 'images': 0, 'flagged': 0})
        for alb, meta in cur.items():
            cam = alb.rsplit('/', 1)[-1] if '/' in alb else alb
            by_cam[cam]['albums'] += 1
            by_cam[cam]['images'] += meta['n']
            by_cam[cam]['flagged'] += meta['n_flagged']
        rows = [{'camera': c, **v} for c, v in by_cam.items()]
        rows.sort(key=lambda r: (-r['albums'], r['camera']))  # most-used first
        self._json({'cameras': rows})

    def api_albums(self, qs):
        q      = (qs.get('q',      [''])[0]).lower()
        year   = (qs.get('year',   [''])[0])
        camera = (qs.get('camera', [''])[0])
        with _lock:
            cur = rebuild_current_album_index()
        fam_n = defaultdict(int)
        for alb, meta in cur.items():
            fam_n[meta['orig_root']] += 1

        rows = []
        for alb, meta in cur.items():
            if q and q not in alb.lower():
                continue
            if year and meta['year'] != year:
                continue
            cam = alb.rsplit('/', 1)[-1] if '/' in alb else alb
            if camera and cam != camera:
                continue
            user_meta = _album_meta_user.get(alb, {})
            rows.append({
                'id': alb,
                'orig_root': meta['orig_root'],
                'split_part': fam_n[meta['orig_root']] > 1,
                'n': meta['n'],
                'n_flagged': meta['n_flagged'],
                'date_min': meta['date_min'],
                'date_max': meta['date_max'],
                'cover': meta['cover'],
                'year': meta['year'],
                'camera': cam,
                'display_name': user_meta.get('name', ''),
                'has_meta': bool(user_meta),
            })
        rows.sort(key=lambda r: r['id'])
        self._json({'albums': rows, 'total': len(rows)})

    def api_album(self, qs):
        alb = qs.get('id', [''])[0]
        if not alb:
            self.send_error(400); return
        with _lock:
            imgs = [{**im, 'f': im['p'] in _flagged}
                    for im in _images if current_album(im['p']) == alb]
            imgs.sort(key=lambda im: (im['d'] or 'zzz', im['p']))
            n_flagged = sum(1 for im in imgs if im['f'])
            cur_index = rebuild_current_album_index()
        root = root_of(alb)
        rel_sug = [s for s in _suggestions.get('split', [])
                   if root_of(s['album']) == root]
        # only surface merge suggestions where BOTH sides still exist as live
        # albums (a merged-away album shouldn't keep appearing here).
        live = set(cur_index.keys())
        rel_merge = [s for s in _suggestions.get('merge', [])
                     if (root_of(s['a']) == root or root_of(s['b']) == root)
                     and s['a'] in live and s['b'] in live][:30]

        # Always-on top-K nearest by cosine, regardless of pre-computed cap.
        # Uses in-memory album_means; for split-derived albums we fall back to
        # the original root's mean.
        nearest = []
        if _alb_means is not None:
            key = alb if alb in _orig_alb_to_idx else root
            i = _orig_alb_to_idx.get(key)
            if i is not None:
                sims = (_alb_means @ _alb_means[i]).astype(np.float32)
                sims[i] = -1.0
                k = min(20, len(sims) - 1)
                top = np.argpartition(-sims, k - 1)[:k]
                top = top[np.argsort(-sims[top])]
                seen = {alb}
                for ti in top:
                    other = _orig_alb_ids[int(ti)]
                    if other in seen or other not in cur_index:
                        continue
                    seen.add(other)
                    meta = cur_index[other]
                    nearest.append({
                        'id':   other,
                        'cos':  float(sims[int(ti)]),
                        'n':    meta.get('n', 0),
                        'date_min': meta.get('date_min', ''),
                        'date_max': meta.get('date_max', ''),
                        'cover':    meta.get('cover', ''),
                        'still_exists': True,
                    })
                    if len(nearest) >= 12:
                        break
        self._json({
            'id': alb,
            'n': len(imgs),
            'n_flagged': n_flagged,
            'images': imgs,
            'split_suggestions': rel_sug[:5],
            'merge_suggestions': rel_merge,
            'nearest_albums': nearest,
            'meta': _album_meta_user.get(alb, {}),
        })

    def api_suggestions(self, qs):
        with _lock:
            cur = rebuild_current_album_index()
        # Filter suggestions to ones whose albums still exist in current state.
        # (After a merge / split, some original ids may be gone.)
        cur_set = set(cur.keys())
        merge = []
        for s in _suggestions.get('merge', []):
            if s['a'] in cur_set and s['b'] in cur_set:
                merge.append({**s,
                              'a_meta': cur[s['a']],
                              'b_meta': cur[s['b']]})
            if len(merge) >= 200:
                break
        split = []
        for s in _suggestions.get('split', []):
            if s['album'] in cur_set:
                split.append({**s, 'album_meta': cur[s['album']]})
            if len(split) >= 200:
                break
        self._json({'merge': merge, 'split': split,
                    'built_at': _suggestions.get('built_at', '')})

    # ---- mutating endpoints ----
    def api_merge(self):
        """Event-merge with camera preserved.

        Albums look like `year/event/camera`. Merging selected albums sends
        every photo into `<target_year>/<target_event>/<its_camera>`, where
        `<target_year>/<target_event>` is taken from the FIRST selected id.

        - Same-camera photos collapse into one album.
        - Different-camera photos stay as separate camera sub-albums under
          the same shared event.

        One history entry covers the whole operation.
        """
        body = self._read_json()
        ids = body.get('album_ids') or []
        if len(ids) < 2:
            self._json({'error': 'need >= 2 album ids'}, 400); return

        target_prefix = ids[0].rsplit('/', 1)[0]   # year/event
        sel_set = set(ids)
        results = {}   # new_album_id -> {'n_moved': N, 'absorbed_from': set(...)}
        changes = []

        with _lock:
            for im in _images:
                ca = current_album(im['p'])
                if ca not in sel_set:
                    continue
                cam = ca.rsplit('/', 1)[-1] if '/' in ca else ca
                new_id = f'{target_prefix}/{cam}'
                if new_id == ca:
                    continue   # already in the right place
                changes.append((im['p'], ca))
                _overrides[im['p']] = new_id
                r = results.setdefault(new_id, {'n_moved': 0, 'absorbed_from': set()})
                r['n_moved'] += 1
                r['absorbed_from'].add(ca)

            if changes:
                action = {
                    'type': 'merge',
                    't': time.time(),
                    'mode': 'event-with-camera-preserved',
                    'target_event': target_prefix,
                    'results': [
                        {'new_album': k,
                         'n_moved':   v['n_moved'],
                         'absorbed_from': sorted(v['absorbed_from'])}
                        for k, v in results.items()
                    ],
                    'changes': changes,
                }
                _history.append(action)
                save_state()
        self._json({
            'ok': True,
            'target_event': target_prefix,
            'results': [
                {'new_album': k,
                 'n_moved':   v['n_moved'],
                 'absorbed_from': sorted(v['absorbed_from'])}
                for k, v in results.items()
            ],
            'n_moved_total': len(changes),
            'history_len': len(_history),
        })

    def api_split(self):
        """Two modes:
          - cutoff:  body = {album_id, cut_after_path, side: 'after'|'before'}
                     moves everything on one side of cut_path (sorted by date).
          - subset:  body = {album_id, move_paths: [path, ...]}
                     moves exactly those paths, leaves the rest.
        """
        body = self._read_json()
        alb = body.get('album_id') or ''
        move_paths = body.get('move_paths') or None
        cut_path = body.get('cut_after_path') or ''
        side = body.get('side', 'after')
        if not alb:
            self._json({'error': 'album_id required'}, 400); return
        if not move_paths and not cut_path:
            self._json({'error': 'move_paths or cut_after_path required'}, 400); return
        with _lock:
            imgs = [im for im in _images if current_album(im['p']) == alb]
            album_paths = {im['p'] for im in imgs}
            if move_paths:
                # subset mode — exact list of paths to peel off
                move = [p for p in move_paths if p in album_paths]
                if not move:
                    self._json({'error': 'none of move_paths are in album'}, 400); return
                if len(move) == len(album_paths):
                    self._json({'error': 'split would empty source album'}, 400); return
                mode = 'subset'
            else:
                imgs.sort(key=lambda im: (im['d'] or 'zzz', im['p']))
                paths = [im['p'] for im in imgs]
                if cut_path not in paths:
                    self._json({'error': 'cut_after_path not in album'}, 400); return
                idx = paths.index(cut_path)
                move = paths[idx + 1:] if side == 'after' else paths[:idx + 1]
                if not move or len(move) == len(paths):
                    self._json({'error': 'split would leave one side empty'}, 400); return
                mode = 'cutoff'

            new_id = next_split_id(alb)
            changes = []
            for p in move:
                changes.append((p, current_album(p)))
                _overrides[p] = new_id
            action = {
                'type': 'split',
                't': time.time(),
                'from': alb,
                'into': new_id,
                'mode': mode,
                'cut_after_path': cut_path,
                'side': side,
                'n_moved': len(move),
                'changes': changes,
                'split_counter_root': root_of(alb),
            }
            _history.append(action)
            save_state()
        self._json({'ok': True, 'new_album': new_id,
                    'mode': mode,
                    'n_moved': len(move),
                    'history_len': len(_history)})

    def api_undo(self):
        with _lock:
            if not _history:
                self._json({'error': 'nothing to undo'}, 400); return
            act = _history.pop()
            t = act['type']
            if t == 'flag':
                # 'changes' is a list of paths whose flag state was toggled
                if act['flag']:
                    for p in act['changes']:
                        _flagged.discard(p)
                else:
                    for p in act['changes']:
                        _flagged.add(p)
            elif t == 'album_meta':
                alb = act['album']
                prev = act.get('prev') or {}
                if prev:
                    _album_meta_user[alb] = prev
                else:
                    _album_meta_user.pop(alb, None)
            else:
                # merge / split — 'changes' is [(path, prev_album), ...]
                for p, prev in act['changes']:
                    if prev == _orig_album.get(p):
                        _overrides.pop(p, None)
                    else:
                        _overrides[p] = prev
                if t == 'split':
                    root = act['split_counter_root']
                    try:
                        used_idx = int(act['into'].rsplit('_', 1)[-1])
                        if _split_counters.get(root) == used_idx:
                            _split_counters[root] = used_idx - 1
                            if _split_counters[root] <= 0:
                                _split_counters.pop(root, None)
                    except ValueError:
                        pass
            save_state()
        self._json({'ok': True, 'undone': t,
                    'history_len': len(_history)})

    def api_flag(self):
        body = self._read_json()
        paths = body.get('paths') or []
        alb_ids = body.get('album_ids') or []
        flag = bool(body.get('flag', True))
        with _lock:
            # expand album_ids to their current images
            if alb_ids:
                want = set(alb_ids)
                paths = list(paths) + [im['p'] for im in _images
                                       if current_album(im['p']) in want]
            paths = [p for p in paths if p in _orig_album]
            changed = []
            for p in paths:
                was = p in _flagged
                if flag and not was:
                    _flagged.add(p); changed.append(p)
                elif not flag and was:
                    _flagged.discard(p); changed.append(p)
            if changed:
                _history.append({
                    'type': 'flag', 't': time.time(), 'flag': flag,
                    'changes': changed,
                })
                save_state()
        self._json({'ok': True, 'n_changed': len(changed),
                    'now_flagged': len(_flagged),
                    'history_len': len(_history)})

    def api_group_candidates(self, qs):
        """Top-K albums nearest to the averaged mean-embedding of the given
        album ids. Use when the user has selected multiple albums for merge
        and wants 'what else looks like this set'.

        GET /api/group_candidates?id=A&id=B&id=C&k=12
        """
        ids = [x for x in (qs.get('id') or []) if x]
        if not ids:
            self._json({'error': 'at least one id required'}, 400); return
        if _alb_means is None:
            self._json({'error': 'album_means not loaded'}, 503); return
        try:
            k = max(3, min(int((qs.get('k', ['12'])[0])), 40))
        except ValueError:
            k = 12
        rows = []
        resolved = []
        for a in ids:
            key = a if a in _orig_alb_to_idx else root_of(a)
            idx = _orig_alb_to_idx.get(key)
            if idx is not None:
                rows.append(idx); resolved.append(a)
        if not rows:
            self._json({'error': 'no embeddings for given ids'}, 404); return
        agg = _alb_means[rows].mean(0)
        n = np.linalg.norm(agg)
        if n == 0:
            self._json({'error': 'zero aggregate embedding'}, 500); return
        agg = (agg / n).astype(np.float32)
        sims = (_alb_means @ agg).astype(np.float32)
        for r in rows:
            sims[r] = -1.0
        kk = min(k * 4, len(sims))
        top = np.argpartition(-sims, kk - 1)[:kk]
        top = top[np.argsort(-sims[top])]
        with _lock:
            cur = rebuild_current_album_index()
        seen = set(ids)
        out = []
        for ti in top:
            oid = _orig_alb_ids[int(ti)]
            if oid in seen:
                continue
            seen.add(oid)
            meta = cur.get(oid) or _album_meta.get(oid) or {}
            out.append({
                'id':   oid,
                'cos':  float(sims[int(ti)]),
                'n':    meta.get('n', 0),
                'date_min': meta.get('date_min', ''),
                'date_max': meta.get('date_max', ''),
                'cover':    meta.get('cover', ''),
                'still_exists': oid in cur,
            })
            if len(out) >= k:
                break
        self._json({'group_ids': resolved, 'k': k,
                    'n_albums_in_group': len(rows),
                    'candidates': out})

    def api_photo_group_neighbors(self):
        """Top-K most-similar photos to the mean embedding of the given
        paths. Used by the album view to show 'similar to the photos you
        highlighted'.
        """
        body = self._read_json()
        paths = body.get('paths') or []
        try:
            k = max(3, min(int(body.get('k', 12)), 60))
        except (TypeError, ValueError):
            k = 12
        if _emb is None:
            self._json({'error': 'embeddings not loaded'}, 503); return
        if not paths:
            self._json({'error': 'paths required'}, 400); return
        rows = [_path_to_idx[p] for p in paths if p in _path_to_idx]
        if not rows:
            self._json({'error': 'no embeddings for given paths'}, 404); return
        q = _emb[rows].mean(0).astype(np.float32)
        n = np.linalg.norm(q)
        if n == 0:
            self._json({'error': 'zero aggregate'}, 500); return
        q = q / n
        sims = (_emb @ q).astype(np.float32)
        excl = set(rows)
        for r in rows: sims[r] = -1.0
        with _lock:
            my_albs = set(current_album(p) for p in paths if p in _orig_album)
            kk = min(len(sims), k * 6)
            top = np.argpartition(-sims, kk - 1)[:kk]
            top = top[np.argsort(-sims[top])]
            out = []
            for ti in top:
                im = _images[int(ti)]
                if int(ti) in excl:
                    continue
                a = current_album(im['p'])
                out.append({
                    'p': im['p'], 'a': a, 'd': im['d'],
                    'cos': float(sims[int(ti)]),
                    'same_album': bool(a in my_albs),
                    'f': im['p'] in _flagged,
                })
                if sum(1 for r in out if not r['same_album']) >= k:
                    break
        self._json({'k': k, 'n_input': len(rows), 'neighbors': out})

    def api_album_meta_get(self, qs):
        alb = qs.get('id', [''])[0]
        if not alb:
            self.send_error(400); return
        meta = _album_meta_user.get(alb, {})
        self._json({'id': alb, 'meta': meta})

    def api_album_meta_post(self):
        body = self._read_json()
        alb = body.get('id') or ''
        if not alb:
            self._json({'error': 'id required'}, 400); return
        fields = {}
        for k in ('name', 'year', 'location', 'tags', 'notes'):
            if k in body:
                v = body[k]
                if k == 'tags' and isinstance(v, str):
                    v = [t.strip() for t in v.split(',') if t.strip()]
                fields[k] = v
        with _lock:
            prev = dict(_album_meta_user.get(alb, {}))
            cur  = dict(prev)
            cur.update(fields)
            cur['updated_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
            if cur != prev:
                _album_meta_user[alb] = cur
                _history.append({
                    'type': 'album_meta', 't': time.time(),
                    'album': alb, 'prev': prev, 'new': cur,
                })
                save_state()
        self._json({'ok': True, 'id': alb, 'meta': _album_meta_user.get(alb, {}),
                    'history_len': len(_history)})

    def api_suggest_album_meta(self):
        body = self._read_json()
        alb = body.get('id') or ''
        if not alb:
            self._json({'error': 'id required'}, 400); return
        force = bool(body.get('force_regenerate', False))
        cp = get_collage(alb, force=force)
        if cp is None or not cp.exists():
            self._json({'error': 'collage generation failed'}, 500); return
        img_b64 = base64.b64encode(cp.read_bytes()).decode()
        with _lock:
            n_images = sum(1 for im in _images if current_album(im['p']) == alb)
            existing = dict(_album_meta_user.get(alb, {}))
        prompt = build_suggest_prompt(alb, existing, n_images)
        result = call_gemini(prompt, img_b64)
        if 'error' in result:
            self._json(result, 502); return
        self._json({'ok': True, 'id': alb, 'suggestion': result, '_engine': 'gemini-3.5-flash'})

    def api_album_collage(self, qs):
        alb = qs.get('id', [''])[0]
        if not alb:
            self.send_error(400); return
        p = get_collage(alb)
        if p is None or not p.exists():
            self.send_error(404); return
        data = p.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'public, max-age=300')
        self.end_headers()
        self.wfile.write(data)

    def api_photo_neighbors(self, qs):
        """Top-K visually most-similar photos across the archive (excludes
        self; tags whether each neighbor is in the same current album).
        """
        if _emb is None:
            self._json({'error': 'embeddings not loaded'}, 503); return
        p = qs.get('p', [''])[0]
        try:
            k = max(3, min(int(qs.get('k', ['12'])[0]), 60))
        except ValueError:
            k = 12
        i = _path_to_idx.get(p)
        if i is None:
            self._json({'error': 'unknown path'}, 404); return
        q = _emb[i].astype(np.float32)            # (512,)
        sims = (_emb @ q).astype(np.float32)      # (N,)
        sims[i] = -1.0
        # also drop other photos that are currently in the SAME album as p —
        # the user already sees those in the grid, neighbors are interesting
        # cross-album
        with _lock:
            my_alb = current_album(p)
            # take a larger top-K than requested so we can filter and still
            # return k cross-album rows
            kk = min(len(sims), k * 6)
            top_idx = np.argpartition(-sims, kk - 1)[:kk]
            top_idx = top_idx[np.argsort(-sims[top_idx])]   # exact order
            out_rows = []
            for ti in top_idx:
                im = _images[int(ti)]
                a  = current_album(im['p'])
                same = (a == my_alb)
                out_rows.append({
                    'p': im['p'], 'a': a, 'd': im['d'],
                    'cos': float(sims[int(ti)]),
                    'same_album': bool(same),
                    'f': im['p'] in _flagged,
                })
                if sum(1 for r in out_rows if not r['same_album']) >= k:
                    break
        self._json({'path': p, 'album': my_alb, 'k': k, 'neighbors': out_rows})

    def api_janus_status(self):
        ok, ep = janus_endpoint_healthy()
        state = janus_job_state()
        self._json({
            'endpoint': ep,
            'endpoint_ready': ok,
            'job_state': state,           # 'r' / 'qw' / ''
            'can_use_now': ok,
            'job_script_exists': JANUS_JOB_SCRIPT.is_file(),
        })

    def api_janus_start(self):
        if not JANUS_JOB_SCRIPT.is_file():
            self._json({'error': f'{JANUS_JOB_SCRIPT.name} missing'}, 500); return
        state = janus_job_state()
        if state in ('r', 'qw'):
            self._json({'ok': True, 'note': f'already submitted (state={state})'}); return
        try:
            r = subprocess.run(
                ['bash', '-lc', f'cd {ROOT} && {SGE_SOURCE} qsub janus_server_job.sh'],
                capture_output=True, text=True, timeout=30)
            out = (r.stdout + r.stderr).strip()
            ok = ('has been submitted' in out) or (r.returncode == 0 and 'Your job' in out)
            self._json({'ok': ok, 'submit_output': out[:400]})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def api_janus_stop(self):
        try:
            out = subprocess.run(
                ['bash', '-lc', f'{SGE_SOURCE} qstat -u sarmad'],
                capture_output=True, text=True, timeout=20).stdout
            jids = []
            for line in out.splitlines():
                if 'janus_server' in line:
                    parts = line.split()
                    if parts and parts[0].isdigit():
                        jids.append(parts[0])
            if not jids:
                self._json({'ok': True, 'note': 'no janus_server job to stop'}); return
            r = subprocess.run(
                ['bash', '-lc', f'{SGE_SOURCE} qdel ' + ' '.join(jids)],
                capture_output=True, text=True, timeout=20)
            self._json({'ok': True, 'killed': jids, 'qdel_output': (r.stdout+r.stderr)[:300]})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def api_suggest_album_meta_janus(self):
        body = self._read_json()
        alb = body.get('id') or ''
        if not alb:
            self._json({'error': 'id required'}, 400); return
        cp = get_collage(alb, force=bool(body.get('force_regenerate', False)))
        if cp is None or not cp.exists():
            self._json({'error': 'collage generation failed'}, 500); return
        img_b64 = base64.b64encode(cp.read_bytes()).decode()
        # Janus prompt focused on visual description; keep it concise.
        prompt = (
            'Describe what is shown in this 4x4 photo collage. Focus on subjects, '
            'setting, activities, mood. Output 2-3 sentences, no markdown.'
        )
        result = call_janus(img_b64, prompt=prompt)
        if 'error' in result:
            self._json(result, 502); return
        desc = (result.get('description') or '').strip()
        tags = tags_from_text(desc, limit=6)
        suggestion = {
            'notes': desc[:400],
            'tags':  tags,
            # name/year/location intentionally left blank — Janus is image-only
            'name':  '',
            'year':  '',
            'location': '',
        }
        self._json({'ok': True, 'id': alb, 'suggestion': suggestion, '_engine': 'janus'})

    def api_reset(self):
        """Wipe ALL edits: overrides, history, split counters, flags, album_meta.
        Requires {confirm: 'YES'} in the body to discourage accidents. Writes
        a timestamped backup of state.json first."""
        body = self._read_json()
        if body.get('confirm') != 'YES':
            self._json({'error': 'confirmation required (POST {"confirm":"YES"})'}, 400); return
        with _lock:
            # backup if state.json exists
            if STATE_FILE.exists():
                ts = time.strftime('%Y%m%d_%H%M%S')
                bp = BASE / f'state.backup.{ts}.json'
                bp.write_bytes(STATE_FILE.read_bytes())
            stats_before = {
                'overrides': len(_overrides),
                'history':   len(_history),
                'flagged':   len(_flagged),
                'album_meta': len(_album_meta_user),
            }
            _overrides.clear()
            _history.clear()
            _split_counters.clear()
            _flagged.clear()
            _album_meta_user.clear()
            save_state()
        self._json({'ok': True, 'cleared': stats_before,
                    'backup': f'state.backup.*.json (in image_bench/)'})

    def api_flagged_list(self):
        with _lock:
            cur = rebuild_current_album_index()
            rows = []
            for p in sorted(_flagged):
                if p not in _orig_album:
                    continue
                rows.append({'p': p, 'a': current_album(p)})
        self._json({'flagged': rows, 'n': len(rows)})

    def api_export(self):
        """Export current image -> album mapping + deletion flag list."""
        with _lock:
            out = {
                'image_to_album': {im['p']: current_album(im['p']) for im in _images},
                'flagged_for_deletion': sorted(_flagged),
                'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            }
        body = json.dumps(out).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Disposition',
                         'attachment; filename="image_bench_export.json"')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Threaded(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    load_all()
    with Threaded(('0.0.0.0', PORT), H) as srv:
        log(f'image_bench listening on :{PORT}')
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            log('shutting down')


if __name__ == '__main__':
    main()
