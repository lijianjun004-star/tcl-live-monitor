"""Exercise the active exploration policy on the frozen candidate pool.

This verifies real scheduling and scoring, not new model-driven discovery.
"""
import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from dream_rsi.env.runner import run_live
from dream_rsi.exploration.config import ExploreConfig
from dream_rsi.policy.load import load_policy
if __package__:
    from .run import SessionFileAdapter, CONFIG
    from .runtime import ROOT, load_active
else:
    from run import SessionFileAdapter, CONFIG
    from runtime import ROOT, load_active

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--budget', type=int, choices=range(1,5), default=3)
    args = parser.parse_args()
    _, active = load_active()
    parent = ROOT/'runs'/active['run_id']
    manifest = json.loads((parent/'frozen_manifest.json').read_text())
    sources = {node:parent/'frozen'/f'{node}.py' for node in manifest['candidate_hashes']}
    for node,path in sources.items():
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest['candidate_hashes'][node]:
            raise ValueError(f'Candidate hash mismatch: {node}')
    policy = active['policy']
    if policy != 'baseline':
        if hashlib.sha256(Path(policy).read_bytes()).hexdigest() != active['policy_sha256']:
            raise ValueError('Active policy hash mismatch')
    workspace = parent/'activation-probes'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    result = run_live(workspace, SessionFileAdapter(sources), policy=load_policy(policy, config=CONFIG),
                      config=ExploreConfig(problem=ROOT/'problem.txt', evaluator=ROOT/'evaluator.py',
                                           init_program=sources['b0_a0'], eval_python=sys.executable),
                      budget=args.budget, max_width=2, max_refine=1, max_workers=1)
    report = dict(mode='active-policy scheduling check on unchanged candidates', model_requests=0,
                  requested_budget=args.budget, result=asdict(result))
    (workspace/'activation-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    if result.failed:
        raise RuntimeError(f'Candidate execution failed: {result.failed}')
    print(json.dumps(dict(best_score=result.sim.best,attempts=len(result.node_ids),
                         visited=result.node_ids,evidence=str(workspace/'activation-check.json')),indent=2))

if __name__ == '__main__':
    main()
