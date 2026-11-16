"""Verify scoring, regression gates and activation controls with local data."""
import hashlib
import json
from pathlib import Path
import pytest
from .evaluator import score_records, evaluate
from .run import extraction_gate
from .runtime import load_active, rollback

ROW = dict(text='evidence', author='writer', tags=['test'])

def test_scorer_penalizes_missing_and_fabricated_records():
    assert score_records([], [ROW]) == 0
    assert score_records([ROW, ROW], [ROW]) < 1
    assert score_records([ROW, dict(ROW, text='fabricated')], [ROW]) < 1
    assert score_records([dict(ROW, author='wrong')], [ROW]) < 1
    assert score_records([ROW], [ROW]) == 1

def test_scorer_rejects_malformed_records():
    with pytest.raises(ValueError):
        score_records([dict(ROW, tags='test')], [ROW])
    with pytest.raises(ValueError):
        score_records([dict(ROW, unexpected='extra')], [ROW])

def result(scores):
    return dict(combined_score=sum(scores)/len(scores),
                problems=[dict(case_id=str(i),score=s,error=None) for i,s in enumerate(scores)])

def test_gate_rejects_average_gain_with_a_regression():
    assert not extraction_gate(result([1, 0]), result([.9, 1]))
    assert extraction_gate(result([1, 0]), result([1, 1]))
    assert not extraction_gate(result([1, 1]), result([1, 1]))
    changed = result([1,1])
    changed['problems'][0]['case_id'] = 'different'
    assert not extraction_gate(result([1,0]), changed)

def test_candidate_exception_is_scored_zero(tmp_path):
    program = tmp_path/'broken.py'
    program.write_text('def extract(html):\n    raise ValueError("broken candidate")\n')
    r = evaluate(program, split='dev')
    assert r['combined_score'] == 0
    assert all(p['error'] for p in r['problems'])

def test_candidate_timeout_is_scored_zero(tmp_path, monkeypatch):
    from . import evaluator
    program = tmp_path/'timeout.py'
    program.write_text('def extract(html): pass\n')
    def timeout(*args, **kwargs):
        raise evaluator.subprocess.TimeoutExpired('candidate', 5)
    monkeypatch.setattr(evaluator.subprocess, 'run', timeout)
    r = evaluate(program, split='dev')
    assert r['combined_score'] == 0
    assert all(p['error'] for p in r['problems'])

def test_activation_checks_integrity_and_rollback_preserves_history(tmp_path):
    frozen = tmp_path/'runs/example/frozen'
    frozen.mkdir(parents=True)
    seed = frozen/'b0_a0.py'
    seed.write_text('def extract(html): return []\n')
    candidate = frozen/'b1_a1.py'
    candidate.write_text('def extract(html): return [dict(text="ok", author="", tags=[])]\n')
    activation = dict(run_id='example', extractor=str(candidate),
                      extractor_sha256=hashlib.sha256(candidate.read_bytes()).hexdigest(), policy='baseline')
    (tmp_path/'active.json').write_text(json.dumps(activation))
    assert load_active(tmp_path)[0]('')[0]['text'] == 'ok'
    candidate.write_text('# tampered\n')
    with pytest.raises(ValueError,match='version mismatch'):
        load_active(tmp_path)
    rollback(tmp_path)
    assert load_active(tmp_path)[0]('') == []
    assert json.loads((frozen.parent/'before-rollback.json').read_text()) == activation
