#!/usr/bin/env python3
"""Generate photos.js (the bundled-image index) and CREDITS.md from the import results."""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ.get("TRIPFLOW_WORK", os.path.join(HERE, ".work"))
ROOT = os.path.dirname(HERE)

def clean(s): return re.sub(r"\s+", " ", str(s or "")).strip()

res = {}
import glob
# Earliest first, so a later corrective run always supersedes the original match.
for path in sorted(glob.glob(os.path.join(SCRATCH, "results*.json")), key=os.path.getmtime):
    for r in json.load(open(path)):
        res[r["key"]] = r
res = list(res.values())

ok = sorted([r for r in res if not r.get("missing")], key=lambda r: r["key"])
# Drop any entry whose file is not actually on disk, so the index can never promise a 404.
ok = [r for r in ok if os.path.exists(os.path.join(ROOT, "images", r["key"] + ".jpg"))]

# Two keys can hold byte-identical files: "La Mamounia Restaurant" is inside the La Mamounia
# hotel, so both legitimately matched the same article and downloaded the same photo. The
# in-page claim guard keys on path, so it cannot see that. Collapse them here instead: keep one
# key per distinct image and drop the rest, so the loser falls through to its next option (the
# restaurant to a plate of its cuisine). Priority keeps the photo with whoever it depicts.
import hashlib
def _rank(r):
    kind = r["key"].split("/")[0]
    return ({"dest": 0, "scene": 1, "cuisine": 1, "category": 1, "site": 0,
             "place": 2}.get(kind, 3),
            0 if clean(r.get("tier_label")).lower() == clean(r["label"]).lower() else 1,
            {"a": 0, "h": 1, "r": 2}.get(r["key"].rsplit("-", 1)[-1][:1], 3),
            r["key"])

seen_hash, deduped, dropped = {}, [], []
for r in sorted(ok, key=_rank):
    path = os.path.join(ROOT, "images", r["key"] + ".jpg")
    h = hashlib.md5(open(path, "rb").read()).hexdigest()
    if h in seen_hash:
        dropped.append((r["key"], seen_hash[h])); os.remove(path); continue
    seen_hash[h] = r["key"]; deduped.append(r)
ok = sorted(deduped, key=lambda r: r["key"])

def is_exact(r):
    return clean(r.get("tier_label")).lower() == clean(r["label"]).lower()

# 1 = the photo depicts the thing itself; 2 = an honest area/landmark stand-in.
entries = [json.dumps(r["key"]) + ":" + ("1" if is_exact(r) else "2") for r in ok]
lines, cur = [], ""
for e in entries:
    if len(cur) + len(e) > 94: lines.append("  " + cur); cur = ""
    cur += e + ","
if cur: lines.append("  " + cur.rstrip(","))

scene_index = json.load(open(os.path.join(SCRATCH, "scene_index.json")))
cuisine_keys = json.load(open(os.path.join(SCRATCH, "cuisine_keys.json")))
have = {r["key"] for r in ok}
cuisine_keys = {c: k for c, k in cuisine_keys.items() if k in have}

js = '''/* ============================================================
   TripFlow — bundled photo index (GENERATED, do not hand-edit)

   Every key below has a real, licence-cleared photograph committed under images/.
   data.js consults this index first, so a curated destination or place renders its real
   photo on first paint — no Wikipedia round-trip, no placeholder flash, and it still
   works with the network blocked, throttled or offline.

   The value grades the match: 1 = the photo depicts that place itself, 2 = an honest
   stand-in showing the neighbourhood it is in (used where no photograph of the place
   exists anywhere). Callers that must not overstate what they are showing — a hotel
   card, say — ask for a 1 only. Keys absent altogether keep the generated placeholder
   and the live lookup; a loosely-related photo would misrepresent the place.

   Regenerate with tools/import-images.py. Attribution for every file: CREDITS.md
============================================================ */
window.LOCAL_PHOTOS = {
%s
};

/* Restaurant cuisine -> the dish photo that represents it. Small restaurants almost never
   have a photograph anywhere, and a real plate of what they cook sells the meal honestly
   where a street scene of their block does not. */
window.CUISINE_PHOTO_KEYS = %s;

/* How many distinct scene photos each destination has. Places with no photograph of their
   own are dealt one each, so no two cards on a page ever show the same image. */
window.SCENE_PHOTOS = %s;
''' % ("\n".join(lines), json.dumps(cuisine_keys, indent=1, sort_keys=True),
     json.dumps(scene_index, indent=1, sort_keys=True))
open(os.path.join(ROOT, "photos.js"), "w").write(js)

md = ["# Image credits", "",
      "Every photograph under `images/` was imported from Wikipedia / Wikimedia Commons and",
      "re-encoded to a web-sized progressive JPEG. Copyright remains with the photographers",
      "listed below and each file is used under the licence shown; follow the licence link for",
      "the full terms and the authoritative attribution string.", "",
      "Where the *Depicts* column says \"area stand-in\", no photograph of that specific",
      "business or landmark was available, so the photo shows the neighbourhood it sits in.",
      "Those images are never presented as being of the property itself.", "",
      f"{len(ok)} images. Regenerate with `tools/import-images.py`.", "",
      "| File | Depicts | Source article | Author | Licence |",
      "|---|---|---|---|---|"]
for r in ok:
    label = clean(r["label"])
    if not is_exact(r): label += f" — area stand-in ({clean(r.get('tier_label'))})"
    page = clean(r.get("wiki_page"))
    page_cell = f"[{page}](https://en.wikipedia.org/wiki/{page.replace(' ', '_')})" if page else "—"
    lic, fp = clean(r.get("license")) or "see file page", clean(r.get("file_page"))
    md.append(f"| `images/{r['key']}.jpg` | {label} | {page_cell} | "
              f"{clean(r.get('author')) or 'Unknown'} | {f'[{lic}]({fp})' if fp else lic} |")
md.append("")
open(os.path.join(ROOT, "CREDITS.md"), "w").write("\n".join(md))

exact = sum(1 for r in ok if is_exact(r))
print(f"photos.js: {len(ok)} images ({exact} exact, {len(ok)-exact} area stand-ins), "
      f"{len(cuisine_keys)} cuisines mapped")
print(f"deduplicated: {len(dropped)} byte-identical duplicates removed")
for k, kept in dropped[:6]: print(f"   dropped {k} (same image as {kept})")
