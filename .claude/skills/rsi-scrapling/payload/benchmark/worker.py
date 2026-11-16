"""Subprocess entrypoint for an extractor; stdout is a single JSON result."""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location('candidate', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.extract(sys.stdin.read()), ensure_ascii=False))
