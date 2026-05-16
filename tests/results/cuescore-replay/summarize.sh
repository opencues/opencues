#!/usr/bin/env bash
DIR="$(dirname "$0")"
python3 - "$DIR" <<'PY'
import glob, os, re, sys
DIR = sys.argv[1]
ESC = re.compile(r'\x1b\[[0-9;]*m')

def parse(path):
    text = ESC.sub('', open(path, encoding='utf-8', errors='replace').read())
    acc = re.search(r'^Total:\s+(\d+)/(\d+)\s+pass\s+\(([\d.]+)%\)', text, re.M)
    per = re.search(r'^Avg model \(per case\):\s+(\d+)ms', text, re.M)
    wall = re.search(r'^Wall-clock total:\s+([\d.]+)s', text, re.M)
    if not (acc and per and wall):
        return None
    return int(acc.group(1)), int(acc.group(2)), float(acc.group(3)), int(per.group(1)), float(wall.group(1))

print(f"{'Provider':<11}{'Bench':<10}{'Score':<14}{'Acc %':<8}{'Per-case ms':<14}{'Wall s':<10}")
print("─" * 72)
provs = ['groq', 'cerebras', 'gemini', 'claude', 'openai']
for prov in provs:
    for bench in ['math', 'factual']:
        path = os.path.join(DIR, f"{prov}_{bench}.log")
        r = parse(path) if os.path.exists(path) else None
        if r:
            p, t, a, pc, w = r
            print(f"{prov:<11}{bench:<10}{p}/{t:<11}{a:<8.1f}{pc:<14}{w:<10}")
        else:
            print(f"{prov:<11}{bench:<10}(no result)")
    print()
PY
