"""英語ナレーションの行間(次の行の開始までの無音)の中央値を出す。使い方: python3 scripts/en-dub/gap-median.py <epId>"""
import json, statistics, sys
ep = sys.argv[1]
t = json.load(open(f"episodes/{ep}/timing.json")); d = json.load(open(f"episodes/{ep}/out/en/lines/durations.json")); ls = t["lines"]
g = [(ls[i + 1]["startSec"] if i + 1 < len(ls) else t["totalDurationSec"]) - l["startSec"] - d[l["lineId"]] for i, l in enumerate(ls)]
print(f"{ep} gap_median={statistics.median(g):.2f} over1.5s={sum(x > 1.5 for x in g)}/{len(g)}")
