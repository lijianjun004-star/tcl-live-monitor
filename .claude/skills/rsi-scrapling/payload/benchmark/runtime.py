"""Use a validated immutable extractor, or roll back to its fixed seed."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def load_active(root=ROOT):
    active = json.loads((root/'active.json').read_text())
    path = Path(active['extractor']).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Extractor is outside the versioned benchmark directory')
    if hashlib.sha256(path.read_bytes()).hexdigest() != active['extractor_sha256']:
        raise ValueError('Extractor version mismatch; refusing to load modified source')
    spec = importlib.util.spec_from_file_location('validated_extractor', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.extract, active

def rollback(root=ROOT):
    active_path = root/'active.json'
    previous = json.loads(active_path.read_text())
    seed = root/'runs'/previous['run_id']/'frozen/b0_a0.py'
    # Preserve a named activation record so the validated version is restorable.
    backup = root/'runs'/previous['run_id']/'before-rollback.json'
    if not backup.exists():
        backup.write_text(json.dumps(previous, ensure_ascii=False, indent=2))
    active = dict(previous, extractor=str(seed), extractor_sha256=hashlib.sha256(seed.read_bytes()).hexdigest(),
                  policy='baseline', policy_sha256=None, rolled_back=True)
    temporary = root/'active.next.json'
    temporary.write_text(json.dumps(active, ensure_ascii=False, indent=2))
    temporary.replace(active_path)
    return active

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status','rollback'])
    args = parser.parse_args()
    active = rollback() if args.action == 'rollback' else load_active()[1]
    print(json.dumps(active, ensure_ascii=False, indent=2))
