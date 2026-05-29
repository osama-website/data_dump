#!/usr/bin/env python3
"""
build_index.py — one-time precompute for image_bench.

Reads:
  /old_Users/sarmad/Osama/photo_embedding.jsonl  (file -> 512-d ViT-B-32)
  /old_Users/sarmad/exif_dump.jsonl              (key -> date_exif, gps, ...)

Writes (into ./image_bench/):
  images.json        list of {path, album, date, idx}      one row per image
  embeddings.npy     (N, 512) float32, L2-normalized       index aligns with images.json
  album_index.json   {album_id: {n, date_min, date_max, cover, mean_idx}}
  album_means.npy    (A, 512) float32, mean embedding per album (normalized)
  suggestions.json   {merge: [...], split: [...]}

Rerun whenever the underlying embeddings/EXIF change. Safe to interrupt;
intermediate files are atomically renamed on success.
"""

import json, os, sys, time
from pathlib import Path
from collections import defaultdict
import numpy as np

ROOT = Path('/old_Users/sarmad/Osama')
OUT  = ROOT / 'image_bench'
EMB_JSONL  = ROOT / 'photo_embedding.jsonl'
EXIF_JSONL = Path('/old_Users/sarmad/exif_dump.jsonl')

OUT.mkdir(exist_ok=True)


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def load_exif_dates():
    """basename-stem -> 'YYYY-MM-DD HH:MM:SS'   (first non-None wins)."""
    out = {}
    n = 0
    with open(EXIF_JSONL) as f:
        for line in f:
            d = json.loads(line)
            stem = os.path.splitext(os.path.basename(d['key']))[0].lower()
            de = d.get('date_exif')
            if de and de != 'None' and stem not in out:
                out[stem] = de
            n += 1
            if n % 50000 == 0:
                log(f'  exif read {n}')
    log(f'exif: {n} rows, {len(out)} unique stems w/ date')
    return out


def album_id_from_path(p):
    """thumbnails/<year>/<event>/<camera>/...  ->  '<year>/<event>/<camera>'."""
    parts = p.split('/')
    if len(parts) < 5 or parts[0] != 'thumbnails':
        return None
    return '/'.join(parts[1:4])


def load_embeddings_and_index(exif_dates):
    """Stream photo_embedding.jsonl twice: first to count + size, second to
    fill a preallocated numpy array. Avoids holding 194k Python lists of 512
    floats in memory simultaneously (~3 GB)."""
    log('counting rows in embeddings file ...')
    n_keep = 0
    dim = None
    with open(EMB_JSONL) as f:
        for line in f:
            if '"thumbnails/' not in line:
                continue
            n_keep += 1
            if dim is None:
                d = json.loads(line)
                dim = len(d['embedding'])
    log(f'  will keep {n_keep} rows, dim={dim}')

    arr = np.empty((n_keep, dim), dtype=np.float32)
    paths  = [None] * n_keep
    albums = [None] * n_keep
    dates  = [None] * n_keep

    n = 0
    with open(EMB_JSONL) as f:
        for line in f:
            d = json.loads(line)
            p = d['file']
            alb = album_id_from_path(p)
            if alb is None:
                continue
            stem = os.path.splitext(os.path.basename(p))[0].lower()
            paths[n]  = p
            albums[n] = alb
            dates[n]  = exif_dates.get(stem) or ''
            arr[n]    = d['embedding']
            n += 1
            if n % 20000 == 0:
                log(f'  emb read {n}/{n_keep}')
    # trim in case count drifted (e.g., file edited during count)
    if n != n_keep:
        arr = arr[:n]; paths = paths[:n]; albums = albums[:n]; dates = dates[:n]
    log(f'embeddings: {n} rows kept')
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    arr /= norms
    return paths, albums, dates, arr


def build_album_means(albums, arr, paths, dates):
    by_alb = defaultdict(list)
    for i, a in enumerate(albums):
        by_alb[a].append(i)
    ids = sorted(by_alb)
    means = np.zeros((len(ids), arr.shape[1]), dtype=np.float32)
    info = {}
    for ai, alb in enumerate(ids):
        rows = by_alb[alb]
        m = arr[rows].mean(axis=0)
        n = np.linalg.norm(m)
        if n > 0:
            m /= n
        means[ai] = m
        valid_dates = sorted(d for d in (dates[r] for r in rows) if d)
        info[alb] = {
            'idx': ai,
            'n': len(rows),
            'date_min': valid_dates[0] if valid_dates else '',
            'date_max': valid_dates[-1] if valid_dates else '',
            'cover': paths[rows[0]],
            'rows': rows,
        }
    log(f'albums: {len(ids)} (mean embedding each)')
    return ids, means, info


def parse_date(s):
    if not s:
        return None
    try:
        from datetime import datetime
        return datetime.strptime(s[:19], '%Y-%m-%d %H:%M:%S')
    except Exception:
        return None


def compute_merge_suggestions(ids, means, info, topk_per=3, cos_thresh=0.78,
                              days_thresh=14, limit=2000):
    """For each album, find top-K nearest by cosine that are temporally close
    and have the same event sub-tokens. Output a globally ranked list of
    unordered pairs."""
    log('computing merge suggestions ...')
    seen = set()
    out = []
    # batched matmul to find neighbors
    B = 256
    A = means.shape[0]
    # Precompute event name (the middle part) for soft same-event boost
    ev = []
    yr = []
    cam = []
    for alb in ids:
        parts = alb.split('/')
        yr.append(parts[0] if len(parts) > 0 else '')
        ev.append(parts[1] if len(parts) > 1 else '')
        cam.append(parts[2] if len(parts) > 2 else '')
    for start in range(0, A, B):
        chunk = means[start:start + B]                  # (b, 512)
        sims = chunk @ means.T                          # (b, A)
        for li, alb_a in enumerate(ids[start:start + B]):
            ai = start + li
            row = sims[li].copy()
            row[ai] = -1.0
            # take top candidates by cosine
            top = np.argpartition(-row, min(20, A - 1))[:20]
            for bj in top:
                if bj == ai:
                    continue
                c = float(row[bj])
                if c < cos_thresh:
                    continue
                alb_b = ids[bj]
                key = tuple(sorted((alb_a, alb_b)))
                if key in seen:
                    continue
                # temporal proximity
                da = parse_date(info[alb_a]['date_min']) or parse_date(info[alb_a]['date_max'])
                db = parse_date(info[alb_b]['date_min']) or parse_date(info[alb_b]['date_max'])
                if da and db:
                    gap_days = abs((da - db).total_seconds()) / 86400.0
                else:
                    gap_days = 9999
                if gap_days > days_thresh:
                    continue
                # boost score if same year+event (different camera = obvious merge)
                same_event = (yr[ai] == yr[bj] and ev[ai] == ev[bj] and cam[ai] != cam[bj])
                # also boost if event tokens overlap heavily (same place mention)
                ta = set(ev[ai].lower().replace('—', ' ').split())
                tb = set(ev[bj].lower().replace('—', ' ').split())
                tok_overlap = len(ta & tb) / max(1, len(ta | tb))
                score = c * (1.0 - 0.03 * min(gap_days, 14))
                if same_event:
                    score += 0.20
                score += 0.15 * tok_overlap
                seen.add(key)
                out.append({
                    'a': alb_a, 'b': alb_b,
                    'cos': c, 'gap_days': gap_days,
                    'same_event': same_event,
                    'token_overlap': tok_overlap,
                    'score': float(score),
                })
        if (start // B) % 5 == 0:
            log(f'  merge scan {start}/{A}')
    out.sort(key=lambda r: -r['score'])
    log(f'merge suggestions: {len(out)} pairs (keeping top {limit})')
    return out[:limit]


def compute_split_suggestions(ids, info, arr, dates_all, paths_all, limit=1000):
    """Contiguous split: largest temporal gap with semantic break."""
    log('computing contiguous-split suggestions ...')
    out = []
    for alb in ids:
        meta = info[alb]
        rows = meta['rows']
        if len(rows) < 6:
            continue
        date_rows = []
        for r in rows:
            dt = parse_date(dates_all[r])
            if dt:
                date_rows.append((dt, r))
        if len(date_rows) < 6:
            continue
        date_rows.sort()
        gaps = []
        for i in range(1, len(date_rows)):
            dh = (date_rows[i][0] - date_rows[i - 1][0]).total_seconds() / 3600.0
            gaps.append((dh, i))
        gaps.sort(reverse=True)
        biggest_h, cut_i = gaps[0]
        if biggest_h < 2.0:
            continue
        left  = [r for _, r in date_rows[:cut_i]]
        right = [r for _, r in date_rows[cut_i:]]
        if len(left) < 2 or len(right) < 2:
            continue
        mL = arr[left].mean(0);  mL /= max(1e-9, np.linalg.norm(mL))
        mR = arr[right].mean(0); mR /= max(1e-9, np.linalg.norm(mR))
        cross_cos = float(mL @ mR)
        gap_score = min(biggest_h, 72.0) / 72.0
        sem_score = max(0.0, 1.0 - cross_cos)
        score = 0.55 * gap_score + 0.45 * sem_score
        if score < 0.25:
            continue
        # highlight = smaller side (the "outlier run" the user usually wants
        # to peel off into a new album)
        if len(right) <= len(left):
            side = 'after'
            highlight = right
        else:
            side = 'before'
            highlight = left
        out.append({
            'album': alb,
            'mode': 'contiguous',
            'n': len(date_rows),
            'cut_after_path': paths_all[date_rows[cut_i - 1][1]],
            'cut_after_date': dates_all[date_rows[cut_i - 1][1]],
            'next_date': dates_all[date_rows[cut_i][1]],
            'gap_hours': biggest_h,
            'cross_cos': cross_cos,
            'left_n': len(left),
            'right_n': len(right),
            'side': side,
            'highlight_paths': [paths_all[r] for r in highlight],
            'n_highlight': len(highlight),
            'score': float(score),
        })
    out.sort(key=lambda r: -r['score'])
    log(f'  contiguous splits: {len(out)} albums')
    return out[:limit]


def compute_subset_split_suggestions(ids, info, arr, dates_all, paths_all,
                                      limit=600):
    """Non-contiguous (outlier) split: find a coherent cluster of photos
    inside an album that is (a) far from the album centroid and (b) NOT a
    single chronological run. These are the 'a few stray photos got
    mis-grouped' cases that the largest-gap method misses."""
    log('computing subset-split suggestions ...')
    out = []
    for alb in ids:
        meta = info[alb]
        rows = meta['rows']
        if len(rows) < 10:
            continue
        sub = arr[rows]
        center = sub.mean(0)
        n = np.linalg.norm(center)
        if n == 0:
            continue
        center /= n
        sims = sub @ center                           # cos of each photo to centroid

        # bottom 20%, clamped to [3, 25]
        k = max(3, min(int(0.20 * len(rows)), 25))
        if k >= len(rows) - 3:
            continue
        order = np.argsort(sims)                      # ascending
        outlier_local = order[:k]
        rest_local    = order[k:]

        out_emb = sub[outlier_local]
        oc = out_emb.mean(0); n = np.linalg.norm(oc)
        if n == 0:
            continue
        oc /= n
        out_cohesion = float((out_emb @ oc).mean())

        rest_emb = sub[rest_local]
        rc = rest_emb.mean(0); n = np.linalg.norm(rc)
        if n == 0:
            continue
        rc /= n
        separation = 1.0 - float(oc @ rc)

        if out_cohesion < 0.78 or separation < 0.22:
            continue

        # Check temporal interleaving — count alternation 'runs' between
        # outlier and non-outlier labels along sorted-by-date axis.
        out_set = set(int(x) for x in outlier_local.tolist())
        dated = []
        for local_i, r in enumerate(rows):
            dt = parse_date(dates_all[r])
            if dt is None:
                continue
            dated.append((dt, local_i in out_set))
        if len(dated) < 8:
            continue
        dated.sort(key=lambda x: x[0])
        runs = 1
        for j in range(1, len(dated)):
            if dated[j][1] != dated[j - 1][1]:
                runs += 1
        # contiguous (runs<=2) is already covered by compute_split_suggestions
        if runs <= 2:
            continue

        outlier_paths = [paths_all[rows[i]] for i in outlier_local]
        score = 0.5 * out_cohesion + 0.5 * separation
        out.append({
            'album': alb,
            'mode': 'subset',
            'n': len(rows),
            'highlight_paths': outlier_paths,
            'n_highlight': len(outlier_paths),
            'cohesion': float(out_cohesion),
            'separation': float(separation),
            'runs': int(runs),
            'cross_cos': float(oc @ rc),
            'score': float(score),
        })
    out.sort(key=lambda r: -r['score'])
    log(f'  subset (non-contiguous) splits: {len(out)} albums')
    return out[:limit]


def atomic_dump(obj, path, binary=False):
    tmp = path.with_suffix(path.suffix + '.tmp')
    if binary:
        np.save(tmp, obj, allow_pickle=False)
        tmp = tmp.with_suffix(tmp.suffix + '.npy') if not str(tmp).endswith('.npy') else tmp
        # np.save adds .npy if missing; handle both
    else:
        with open(tmp, 'w') as f:
            json.dump(obj, f)
    os.replace(tmp, path)


def main():
    t0 = time.time()
    exif_dates = load_exif_dates()
    paths, albums, dates, arr = load_embeddings_and_index(exif_dates)
    log(f'embeddings array: {arr.shape}  ({arr.nbytes/1e6:.0f} MB)')
    ids, means, info = build_album_means(albums, arr, paths, dates)

    # --- write images.json (compact: list of [path, album, date]) -----
    images_payload = [
        {'p': paths[i], 'a': albums[i], 'd': dates[i]} for i in range(len(paths))
    ]
    with open(OUT / 'images.json.tmp', 'w') as f:
        json.dump(images_payload, f)
    os.replace(OUT / 'images.json.tmp', OUT / 'images.json')

    np.save(OUT / 'embeddings.npy', arr, allow_pickle=False)
    np.save(OUT / 'album_means.npy', means, allow_pickle=False)

    # album_index.json — drop 'rows' list (huge); keep summary
    summary = {a: {k: v for k, v in info[a].items() if k != 'rows'} for a in ids}
    with open(OUT / 'album_index.json.tmp', 'w') as f:
        json.dump(summary, f)
    os.replace(OUT / 'album_index.json.tmp', OUT / 'album_index.json')

    merge = compute_merge_suggestions(ids, means, info)
    split_contig = compute_split_suggestions(ids, info, arr, dates, paths)
    split_subset = compute_subset_split_suggestions(ids, info, arr, dates, paths)
    split = split_contig + split_subset
    split.sort(key=lambda r: -r['score'])
    log(f'total split suggestions: {len(split)} ({len(split_contig)} contig + {len(split_subset)} subset)')
    with open(OUT / 'suggestions.json.tmp', 'w') as f:
        json.dump({'merge': merge, 'split': split,
                   'built_at': time.strftime('%Y-%m-%d %H:%M:%S')}, f)
    os.replace(OUT / 'suggestions.json.tmp', OUT / 'suggestions.json')

    log(f'done in {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
