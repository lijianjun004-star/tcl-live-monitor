"""Fixed offline scorer usable directly by DREAM-RSI's evaluator interface."""
import collections
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent

def normalize(records):
    if not isinstance(records, list):
        raise ValueError('Expected a list of records')
    result = []
    for r in records:
        if not isinstance(r, dict) or set(r) != {'text', 'author', 'tags'}:
            raise ValueError('Record must contain exactly text, author and tags')
        if not isinstance(r['text'], str) or not isinstance(r['author'], str):
            raise ValueError('Text and author must be strings')
        if not isinstance(r['tags'], list) or any(not isinstance(t, str) for t in r['tags']):
            raise ValueError('Tags must be a list of strings')
        result.append(dict(text=r['text'], author=r['author'], tags=sorted(r['tags'])))
    return result

def f1(actual, expected):
    left, right = collections.Counter(actual), collections.Counter(expected)
    if not left and not right:
        return 1.0
    return 2 * sum((left & right).values()) / (sum(left.values()) + sum(right.values()))

def score_records(actual, expected):
    actual, expected = normalize(actual), normalize(expected)
    record_score = f1([json.dumps(x, sort_keys=True) for x in actual],
                      [json.dumps(x, sort_keys=True) for x in expected])
    def fields(rows):
        return [(r['text'], k, json.dumps(v, ensure_ascii=False))
                for r in rows for k, v in r.items()]
    field_score = f1(fields(actual), fields(expected))
    return .7 * record_score + .3 * field_score

def evaluate(program_path, split=None):
    split = split or os.environ.get('EXTRACTION_SPLIT', 'dev')
    if split not in {'dev', 'holdout'}:
        raise ValueError('Unknown split')
    cases = json.loads((ROOT / 'fixtures' / f'{split}.json').read_text())
    problems = []
    start = time.perf_counter()
    for i, case in enumerate(cases):
        begin = time.perf_counter()
        try:
            completed = subprocess.run([sys.executable, str(ROOT / 'worker.py'), str(Path(program_path).resolve())],
                                       input=case['html'], text=True, capture_output=True, timeout=5)
            if completed.returncode:
                raise ValueError(completed.stderr[-500:])
            score = score_records(json.loads(completed.stdout), case['expected'])
            error = None
        except (ValueError, subprocess.TimeoutExpired, OSError) as exc:
            score, error = 0.0, str(exc)
        problems.append(dict(problem_idx=i, case_id=case['id'], score=score,
                             valid=score >= 1 - 1e-9, error=error,
                             sol_time_ms=(time.perf_counter() - begin) * 1000))
    return dict(combined_score=sum(p['score'] for p in problems) / len(problems),
                n_valid=sum(p['valid'] for p in problems), n_total=len(problems),
                problems=problems, split=split, elapsed_sec=time.perf_counter() - start,
                program_sha256=hashlib.sha256(Path(program_path).read_bytes()).hexdigest())
