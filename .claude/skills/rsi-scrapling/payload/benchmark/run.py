"""Bounded, session-authored candidate evaluation and real DREAM-RSI replay.

No model requests. The adapter supplies frozen source files authored in this
ChatGPT/Codex session; it does not pretend to be an autonomous coding agent.
"""
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys

from dream_rsi.agents.base import AgentResult
from dream_rsi.env.runner import run_live
from dream_rsi.env.trace.raw import load_raw_scores, CellRaw, write_raw_scores
from dream_rsi.exploration.config import ExploreConfig
from dream_rsi.learning.pipeline import run_method
from dream_rsi.policy.baseline import ParallelRefineMethod
from dream_rsi.policy.load import load_policy
if __package__:
    from .evaluator import evaluate
else:
    from evaluator import evaluate

ROOT = Path(__file__).resolve().parent
CONFIG = {'max_width': 2, 'max_refine': 1}
SOURCES = {'b0_a0': ROOT / 'seed.py', 'b0_a1': ROOT / 'candidates/nested.py',
           'b1_a0': ROOT / 'candidates/semantic.py', 'b1_a1': ROOT / 'candidates/robust.py'}

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2))

class SessionFileAdapter:
    name = 'session_authored_frozen_files'

    def __init__(self, sources):
        self.sources = sources

    def run(self, *, node_dir, log_dir, prompt, **kwargs):
        metadata = json.loads((node_dir / 'meta.json').read_text())
        source = self.sources[metadata['id']]
        shutil.copy2(source, node_dir / 'artifact/program.py')
        (node_dir / 'proposal.md').write_text(f'Session-authored candidate: {source.name}.\nNo independent model generation at this node.\n')
        write_json(log_dir / 'provenance.json', dict(mode=self.name, source=str(source), sha256=digest(source), model_requests=0))
        return AgentResult(message='Frozen session-authored candidate supplied')

def extraction_gate(seed, candidate):
    same_cases = len(seed['problems']) == len(candidate['problems']) and all(
        a['case_id'] == b['case_id'] for a, b in zip(seed['problems'], candidate['problems']))
    return (same_cases and candidate['combined_score'] > seed['combined_score'] + 1e-9
            and all(b['score'] + 1e-9 >= a['score'] and not b['error']
                    for a, b in zip(seed['problems'], candidate['problems'])))

def policy_replay(raw, source):
    points = []
    for budget in range(1, 5):
        policy = ParallelRefineMethod(CONFIG) if source == 'baseline' else load_policy(source, config=CONFIG)
        report = run_method(policy, raw, name=str(source), budget=budget)
        if not report.ok:
            raise RuntimeError(report.error)
        points.append(asdict(report))
    return dict(points=points, mean_best=sum(p['best'] for p in points) / len(points))

def main():
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    output = ROOT / 'runs' / run_id
    frozen = output / 'frozen'
    frozen.mkdir(parents=True)
    sources = {}
    for node, source in SOURCES.items():
        dest = frozen / f'{node}.py'
        shutil.copy2(source, dest)
        sources[node] = dest
    frozen_policy = frozen / 'policy_candidate.py'
    shutil.copy2(ROOT / 'policy_candidate.py', frozen_policy)
    write_json(output / 'frozen_manifest.json', dict(candidate_hashes={k:digest(p) for k,p in sources.items()},
               policy_sha256=digest(frozen_policy), split_hashes={s:digest(ROOT/'fixtures'/f'{s}.json') for s in ['dev','holdout']},
               evaluator_sha256=digest(ROOT/'evaluator.py'), worker_sha256=digest(ROOT/'worker.py'),
               author='current ChatGPT/Codex session', model_requests=0,
               policy_objective='mean best score at budgets 1,2,3,4; serial execution only'))
    workspace = output / 'exploration'
    config = ExploreConfig(problem=ROOT/'problem.txt', evaluator=ROOT/'evaluator.py',
                           init_program=sources['b0_a0'], eval_python=sys.executable, eval_timeout_sec=120)
    rollout = run_live(workspace, SessionFileAdapter(sources), policy=ParallelRefineMethod(CONFIG),
                       config=config, budget=4, max_width=2, max_refine=1, max_workers=1)
    if rollout.failed or len(rollout.node_ids) != 4:
        raise RuntimeError(f'Rollout incomplete: {rollout}')
    raw = load_raw_scores(workspace/'raw_scores.json')
    best = max(raw.nodes, key=lambda node: node.raw.combined_score)
    selected_dev_score = best.raw.combined_score
    chosen = sources[best.id]
    write_json(output/'selection-before-holdout.json', dict(node=best.id, sha256=digest(chosen),
               dev_score=best.raw.combined_score, selection='dev score only; frozen before holdout'))
    dev_baseline = policy_replay(raw, 'baseline')
    dev_candidate = policy_replay(raw, frozen_policy)
    # Held-out fixture contents do not participate in candidate or policy selection.
    holdout = {node:evaluate(source, split='holdout') for node,source in sources.items()}
    write_json(output/'holdout-scores.json', holdout)
    for node in raw.nodes:
        score = holdout[node.id]
        node.raw = CellRaw(evaluated=True, combined_score=score['combined_score'],
                           n_valid=score['n_valid'], n_total=score['n_total'])
    raw.baseline = raw.nodes[0].raw
    raw.workspace = 'heldout_measured_replay; not a new online rollout'
    write_raw_scores(raw, output/'holdout-replay-scores.json')
    held_baseline = policy_replay(raw, 'baseline')
    held_candidate = policy_replay(raw, frozen_policy)
    promote_extractor = extraction_gate(holdout['b0_a0'], holdout[best.id])
    promote_policy = (dev_candidate['mean_best'] > dev_baseline['mean_best'] + 1e-9
                      and all(b['best']+1e-9 >= a['best'] for a,b in zip(held_baseline['points'],held_candidate['points'])))
    report = dict(run_id=run_id, mode='session-authored frozen candidates; real evaluations and DREAM-RSI rollout/replay',
                  model_requests=0, dev_selected_node=best.id, dev_selected_score=selected_dev_score,
                  holdout_seed_score=holdout['b0_a0']['combined_score'], holdout_selected_score=holdout[best.id]['combined_score'],
                  holdout_selected_cases_passed=holdout[best.id]['n_valid'], holdout_cases=holdout[best.id]['n_total'],
                  extractor_promoted=promote_extractor, policy_promoted=promote_policy,
                  policy_dev=dict(baseline=dev_baseline,candidate=dev_candidate),
                  policy_holdout=dict(baseline=held_baseline,candidate=held_candidate),
                  limitations=['Two pages from one public demo site plus authored structural fixtures',
                               'Holdout is a fixed regression gate; repeated runs are not new blind validation',
                               'Not autonomous recursive model-driven learning',
                               'Replay objective is serial mean-best over four budgets, not the paper objective'])
    # Immutable promotion payload + atomic active pointer; previous runs stay available.
    selected = chosen if promote_extractor else sources['b0_a0']
    active = dict(run_id=run_id, extractor=str(selected), extractor_sha256=digest(selected),
                  policy=str(frozen_policy) if promote_policy else 'baseline',
                  policy_sha256=digest(frozen_policy) if promote_policy else None,
                  report=str(output/'report.json'))
    write_json(output/'activation.json', active)
    write_json(output/'report.json', report)
    temporary = ROOT/'active.next.json'
    write_json(temporary, active)
    temporary.replace(ROOT/'active.json')
    print(json.dumps({k:v for k,v in report.items() if k not in {'policy_dev','policy_holdout'}},ensure_ascii=False,indent=2))
    print('Evidence:',output/'report.json')

if __name__ == '__main__':
    main()
