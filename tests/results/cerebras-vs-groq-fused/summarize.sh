#!/usr/bin/env bash
# Aggregates the cerebras-vs-groq head-to-head into mean ± stddev across reps.
DIR="$(dirname "$0")"

python3 - "$DIR" <<'PY'
import glob, os, re, statistics, sys
DIR = sys.argv[1]
ESC = re.compile(r'\x1b\[[0-9;]*m')

def parse(path):
    text = ESC.sub('', open(path, encoding='utf-8', errors='replace').read())
    acc = re.search(r'^Total:\s+\d+/\d+\s+pass\s+\(([\d.]+)%\)', text, re.M)
    per = re.search(r'^Avg model \(per case\):\s+(\d+)ms', text, re.M)
    wall = re.search(r'^Wall-clock total:\s+([\d.]+)s', text, re.M)
    if not (acc and per and wall):
        return None
    return float(acc.group(1)), int(per.group(1)), float(wall.group(1))

def mean_sd(xs):
    if not xs: return (None, None)
    if len(xs) == 1: return (xs[0], 0.0)
    return (statistics.mean(xs), statistics.stdev(xs))

print(f"{'Bench':<11}{'Provider':<11}{'Reps':<6}{'Acc %':<14}{'Per-case ms':<22}{'Wall s':<18}Per-rep ms")
print("─" * 110)

for bench in ['transform', 'fluid']:
    for provider in ['groq', 'cerebras']:
        rows = []
        for path in sorted(glob.glob(os.path.join(DIR, f"{bench}_{provider}_*.log"))):
            r = parse(path)
            if r: rows.append(r)
        if not rows:
            print(f"{bench:<11}{provider:<11}n=0   (no completed runs)")
            continue
        accs = [r[0] for r in rows]
        pers = [r[1] for r in rows]
        walls = [r[2] for r in rows]
        m_a, s_a = mean_sd(accs)
        m_p, s_p = mean_sd(pers)
        m_w, s_w = mean_sd(walls)
        print(f"{bench:<11}{provider:<11}n={len(rows):<3} "
              f"{m_a:5.2f} ±{s_a:4.2f}  "
              f"{m_p:6.0f} ±{s_p:5.0f}        "
              f"{m_w:5.2f} ±{s_w:4.2f}      "
              f"{', '.join(str(x) for x in pers)}")
    print()
PY
