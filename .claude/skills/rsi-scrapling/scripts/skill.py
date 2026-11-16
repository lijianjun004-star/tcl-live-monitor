"""Portable Claude skill entrypoint; state lives in a separate writable cache."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def validate():
    text = (ROOT/'SKILL.md').read_text()
    match = re.match(r'^---\n(.*?)\n---\n', text, re.S)
    if not match or 'name: rsi-scrapling' not in match[1] or 'description:' not in match[1]:
        raise SystemExit('Invalid skill frontmatter')
    manifest = json.loads((ROOT/'MANIFEST.json').read_text())
    for name, expected in manifest['files'].items():
        p = ROOT/name
        if p.is_symlink() or not p.resolve().is_relative_to(ROOT) or not p.is_file():
            raise SystemExit('Missing or unsafe skill file: '+name)
        data=p.read_bytes()
        if hashlib.sha256(data).hexdigest()!=expected['sha256'] or len(data)!=expected['bytes']:
            raise SystemExit('Skill checksum mismatch: '+name)
        if p.suffix=='.py':
            ast.parse(data,filename=name)
    return manifest

def location():
    fingerprint=hashlib.sha256((ROOT/'MANIFEST.json').read_bytes()).hexdigest()[:16]
    home=Path(os.environ.get('RSI_SCRAPLING_HOME',str(Path.home()/'.cache/rsi-scrapling'))).expanduser()
    cache=home/fingerprint
    python=cache/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    return cache,python

def require_runtime():
    cache,python=location()
    if not python.is_file():
        raise SystemExit('Runtime absent: run scripts/skill.py setup first')
    return cache,python

def run(args,cwd=None,env=None):
    subprocess.run([str(v) for v in args],cwd=cwd,env=env,check=True)

def setup(mcp):
    if sys.version_info<(3,10):
        raise SystemExit('Python 3.10+ required; Python 3.12 validated')
    cache,python=location()
    cache.mkdir(parents=True,exist_ok=True)
    payload=cache/'payload'
    if not payload.exists():
        shutil.copytree(ROOT/'payload',payload)
    else:
        # Generated benchmark runs may coexist, but shipped source must remain intact.
        for name,spec in json.loads((ROOT/'MANIFEST.json').read_text())['files'].items():
            if name.startswith('payload/'):
                p=cache/name
                if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=spec['sha256']:
                    raise SystemExit('Cached source changed: use a new RSI_SCRAPLING_HOME')
    uv=shutil.which('uv')
    if not python.exists():
        run([uv,'venv',cache/'.venv','--python',sys.executable] if uv else [sys.executable,'-m','venv',cache/'.venv'])
    installer=[uv,'pip','install','--python',python] if uv else [python,'-m','pip','install']
    run([*installer,'-r',ROOT/'requirements.txt'])
    run([*installer,'--no-deps','-e',payload/'vendor/dream-rsi'])
    if mcp:
        run([*installer,'scrapling[ai]==0.5.1'])
    print(json.dumps({'status':'READY','runtime':str(cache),'mcp_requested':mcp,'model_requests':0}))

def self_test(full):
    cache,python=require_runtime()
    env=os.environ.copy()
    for name in ['OPENAI_API_KEY','GEMINI_API_KEY','GEMINI_API_KEYS','GOOGLE_API_KEY','ANTHROPIC_API_KEY','GH_TOKEN','GITHUB_TOKEN']:
        env.pop(name,None)
    payload=cache/'payload'
    run([python,'-m','pytest','-q','benchmark/test_integration.py'],payload,env)
    if full:
        modules=['env','policy','trace_raw','history_and_pool','learning','explore','grid_planning','baseline_champion_toggle','directions']
        run([python,'-m','pytest','-q',*[f'tests/test_{m}.py' for m in modules]],payload/'vendor/dream-rsi',env)
    run([python,'-m','benchmark.run'],payload,env)
    run([python,'-m','benchmark.probe','--budget','3'],payload,env)
    active=json.loads((payload/'benchmark/active.json').read_text())
    report=json.loads(Path(active['report']).read_text())
    if not report['extractor_promoted'] or report['holdout_selected_cases_passed']!=8:
        raise SystemExit('Fixture regression failed')
    result={'status':'PASS','full_upstream_tests':full,'report':active['report'],
            'model_requests':0,'website_requests':0,'autonomous_learning':False}
    (cache/'SELF_TEST.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['validate','status','setup','self-test','collect','probe','mcp-config'])
    parser.add_argument('--mcp',action='store_true')
    parser.add_argument('--full',action='store_true')
    args,extra=parser.parse_known_args()
    validate()
    if args.action=='validate':
        print('PASS: skill metadata, file hashes and Python syntax')
    elif args.action=='status':
        cache,python=location()
        print(json.dumps({'runtime_present':python.is_file(),'runtime':str(cache),'source':'google-research/dream-rsi','scrapling':'0.5.1'}))
    elif args.action=='setup':
        setup(args.mcp)
    elif args.action=='self-test':
        self_test(args.full)
    elif args.action=='mcp-config':
        cache,python=require_runtime()
        if subprocess.run([str(python),'-c','import mcp'],capture_output=True).returncode:
            raise SystemExit('Optional MCP dependency absent: run setup --mcp first')
        command=python.parent/('scrapling.exe' if os.name=='nt' else 'scrapling')
        print(json.dumps({'mcpServers':{'scrapling':{'command':str(command),'args':['mcp']}}},indent=2))
    else:
        cache,python=require_runtime()
        if args.action=='collect':
            run([python,cache/'payload/collect.py',*extra])
        else:
            run([python,'-m','benchmark.probe',*(extra or ['--budget','3'])],cache/'payload')

if __name__=='__main__':
    main()
