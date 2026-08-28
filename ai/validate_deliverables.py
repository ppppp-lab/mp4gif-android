# -*- coding: utf-8 -*-
"""Validate JSONL dataset and compare whitelists between Python and Kotlin."""

import importlib.util
import json
import re
from collections import Counter
from pathlib import Path


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = Path(__file__).parent
generator = load_module("generator", base / "generate_dataset.py")

rows = [json.loads(line) for line in (base / "ai_training_data.jsonl").read_text(encoding="utf-8").splitlines()]
assert len(rows) == 960, f"row count {len(rows)}"
assert len({r["instruction"] for r in rows}) == 960, "duplicate instructions"

counts = Counter()
bad = []
single_count = 0
multi_count = 0
for row in rows:
    assert isinstance(row.get("output"), str), row["instruction"]
    calls = json.loads(row["output"])
    assert isinstance(calls, list) and calls, row["instruction"]
    if len(calls) == 1:
        single_count += 1
    else:
        multi_count += 1
    for call in calls:
        counts[call["method"]] += 1
        if not generator.validate_call(call):
            bad.append((row["instruction"], call))

assert not bad, f"invalid calls: {bad[:3]}"
assert set(generator.SPECS) - set(counts) == set(), "missing methods"

kt_source = (base / "AiDispatcher.kt").read_text(encoding="utf-8")
kt_methods = set(re.findall(r'^\s+"([a-z_]+)" to (?:mapOf|emptyMap)\(', kt_source, re.MULTILINE))
py_methods = set(generator.SPECS)
assert py_methods == kt_methods, f"whitelist mismatch: {py_methods ^ kt_methods}"

print("rows:", len(rows))
print("unique instructions:", len({r["instruction"] for r in rows}))
print("bad calls:", len(bad))
print("method coverage:", len(counts), "/", len(py_methods))
print("min method count:", min(counts.values()), "max:", max(counts.values()))
print("single-action samples:", single_count, "multi-action samples:", multi_count)
print("kotlin whitelist matches python whitelist")
