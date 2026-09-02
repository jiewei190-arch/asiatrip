#!/usr/bin/env python3
"""Build a pool of distinct real photographs for each curated destination.

Places with no photograph of their own used to all fall back to the same single
destination-level shot — Marrakech rendered one photo seven times. This collects several
genuinely different nearby landmarks per destination (via Wikipedia GeoSearch, so every one
is a real place in that city) so each such card can be given a different, still-local photo.
"""
import json, os, sys, io, re, time, urllib.parse, urllib.request, urllib.error
from collections import Counter
import math
from PIL import Image, ImageOps

def haversine(a_lat, a_lng, b_lat, b_lng):
    R = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lng - a_lng)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
UA = "TripFlow-image-import/1.0 (static travel demo site; contact: jiewei190@gmail.com)"
API = "https://en.wikipedia.org/w/api.php"
HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ.get("TRIPFLOW_WORK", os.path.join(HERE, ".work"))
os.makedirs(SCRATCH, exist_ok=True)
ROOT = os.path.dirname(HERE)
PER_DEST = 8

BAD_FILE = re.compile(r"(logo|flag|\bmap\b|coat[_ ]of[_ ]arms|seal|emblem|wordmark|icon|"
                      r"banner|location|locator|blank|outline|chart|diagram|graph)", re.I)
# Proximity is not notability. The first pass returned "Eifukuchō Station" and "Takachiho
# University" for Tokyo — real places, but nothing anyone travels to see.
BAD_TITLE = re.compile(r"(disambiguation|^list of|bombing|attack|massacre|earthquake|cemetery|"
                       r"airport|\bstation\b|\buniversity\b|\bcollege\b|\bschool\b|hospital|"
                       r"prison|barracks|headquarters|\boffice\b|factory|depot|interchange|"
                       r"car park|apartment|dormitory|power (plant|station)|\bward\b|"
                       r"municipality|district council|census|highway|motorway|\bline\b|"
                       r"shooting|\bstadium\b|\bstade\b|\bstadion\b|events? cent(re|er)|olympics|"
                       r"ceremony|championship|\bcommune\b|\bsummit\b|eruption|riot|protest|"
                       r"\bsiege\b|uprising|\bmurder\b|scandal|\bcrash\b|\bfire\b)", re.I)

_last = [0.0]
def api(params, tries=6):
    params = dict(params); params["format"] = "json"
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    for i in range(tries):
        gap = 0.4 - (time.time() - _last[0])
        if gap > 0: time.sleep(gap)
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(req, timeout=40) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503): time.sleep(1.5 * (2 ** i)); continue
            return {}
        except Exception:
            time.sleep(1.0 * (i + 1))
    return {}

def download(url, tries=4):
    """Wikimedia rate-limits image fetches under load. The first run had no retry here, so a
    429 silently dropped a candidate — Marrakech ended with 2 photos out of 24 available."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503): time.sleep(2.0 * (2 ** i)); continue
            return None
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None

def is_flat(im):
    small = im.convert("RGB").resize((72, 72), Image.BILINEAR)
    post = [(r >> 4, g >> 4, b >> 4) for r, g, b in small.getdata()]
    u = len(set(post)); dom = Counter(post).most_common(1)[0][1] / len(post)
    return u < 40 or dom > 0.62 or (u < 90 and dom > 0.45)

def encode(raw, tw=560, th=420, q=74):
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    im = im.convert("RGB")
    sw, sh = im.size
    scale = max(tw / sw, th / sh)
    if scale < 1:
        im = im.resize((round(sw * scale), round(sh * scale)), Image.LANCZOS)
    sw, sh = im.size
    if sw > tw or sh > th:
        l, t = (sw - tw) // 2, (sh - th) // 2
        im = im.crop((l, t, l + min(tw, sw), t + min(th, sh)))
    flat = is_flat(im)
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=q, optimize=True, progressive=True)
    return buf.getvalue(), flat

def _usable(p, taken_files):
    thumb = (p.get("thumbnail") or {}).get("source"); fname = p.get("pageimage") or ""
    if not thumb or not fname: return None
    if fname.lower().endswith(".svg") or BAD_FILE.search(fname): return None
    if fname in taken_files: return None
    if BAD_TITLE.search(p.get("title", "")): return None
    return {"thumb": thumb, "file": fname, "page": p.get("title")}

def scenes_for(dest, taken_files):
    """Photogenic, genuinely local landmarks for a destination, most notable first.

    Two sources, in order of how much a traveller would care:
      1. Wikipedia's own search ranking for the destination name, kept only where the article
         has real coordinates near the destination. Search ranks by notability, so this
         surfaces temples, parks and palaces rather than whatever happens to be nearest.
      2. GeoSearch around the destination's places, as a top-up for thinner destinations
         (Bali's centre point is farmland; its temples are tens of kilometres apart).
    """
    out, seen = [], set()
    def add(p):
        if p.get("title") in seen: return
        seen.add(p.get("title"))
        hit = _usable(p, taken_files)
        if hit: taken_files.add(hit["file"]); out.append(hit)

    # How far this destination genuinely spreads, from its own places. A fixed radius either
    # pulls Yokohama into Tokyo (26km away, a different city) or cuts Bali in half, since its
    # temples sit tens of kilometres apart. Scale it to the destination instead.
    pts = dest.get("points") or []
    spread = max([haversine(dest["lat"], dest["lng"], p["lat"], p["lng"]) for p in pts] or [0])
    radius_km = max(15.0, spread * 1.3)

    for query in (dest["name"], f"{dest['name']} landmarks", f"tourist attractions in {dest['name']}"):
        d = api({"action": "query", "generator": "search", "gsrsearch": query, "gsrlimit": 30,
                 "prop": "pageimages|coordinates", "piprop": "thumbnail|name",
                 "pithumbsize": 560, "colimit": 50})
        pages = ((d.get("query") or {}).get("pages") or {})
        for p in sorted(pages.values(), key=lambda x: x.get("index", 99)):
            co = (p.get("coordinates") or [{}])[0]
            if co.get("lat") is None: continue
            if haversine(dest["lat"], dest["lng"], co["lat"], co["lon"]) > radius_km: continue
            add(p)
        if len(out) >= PER_DEST * 2: return out

    for radius in (8000, 25000):
        for pt in (dest.get("points") or [dest]):
            g = api({"action": "query", "list": "geosearch", "gscoord": f"{pt['lat']}|{pt['lng']}",
                     "gsradius": radius, "gslimit": 40})
            titles = [x["title"] for x in ((g.get("query") or {}).get("geosearch") or [])
                      if x["title"] not in seen and not BAD_TITLE.search(x["title"])]
            for i in range(0, len(titles), 20):
                chunk = titles[i:i+20]
                if not chunk: continue
                r = api({"action": "query", "titles": "|".join(chunk), "prop": "pageimages",
                         "piprop": "thumbnail|name", "pithumbsize": 560})
                order = {t: n for n, t in enumerate(chunk)}
                for p in sorted(((r.get("query") or {}).get("pages") or {}).values(),
                                key=lambda x: order.get(x.get("title", ""), 99)):
                    add(p)
                if len(out) >= PER_DEST * 2: return out
    return out

def main():
    dests = json.load(open(os.path.join(SCRATCH, "dests.json")))
    prior = {}
    for f in ("results.json",):
        for r in json.load(open(os.path.join(SCRATCH, f))):
            if not r.get("missing") and r.get("file"): prior.setdefault(r["key"].split("/")[0], set())
    used_by_dest = {}
    for r in json.load(open(os.path.join(SCRATCH, "results.json"))):
        if r.get("missing") or not r.get("file"): continue
        key = r["key"]
        dst = key.split("/")[1].rsplit("-", 1)[0] if key.startswith("place/") else key.split("/")[1]
        used_by_dest.setdefault(dst, set()).add(r["file"])

    index, credits = {}, []
    existing = {}
    if os.path.exists(os.path.join(SCRATCH, "results_scene.json")):
        for r in json.load(open(os.path.join(SCRATCH, "results_scene.json"))):
            existing.setdefault(r["key"].split("/")[1].rsplit("-", 1)[0], []).append(r)
    for d in dests:
        have = [r for r in existing.get(d["id"], [])
                if os.path.exists(os.path.join(ROOT, "images", r["key"] + ".jpg"))]
        if len(have) >= PER_DEST:
            index[d["id"]] = len(have); credits.extend(have)
            print(f"  {d['id']:<12} {len(have)} scene photos (already complete)", flush=True)
            continue
        taken = set(used_by_dest.get(d["id"], set())) | {r["file"] for r in have}
        credits.extend(have)
        got = len(have)
        for hit in scenes_for(d, taken):
            if got >= PER_DEST: break
            raw = download(hit["thumb"])
            if not raw: continue
            try:
                data, flat = encode(raw)
            except Exception:
                continue
            if flat or len(data) < 12000: continue
            got += 1
            key = f"scene/{d['id']}-{got}"
            path = os.path.join(ROOT, "images", key + ".jpg")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "wb").write(data)
            credits.append({"key": key, "label": f"{d['name']} — {hit['page']}", "kind": "scene",
                            "tier_label": hit["page"], "wiki_page": hit["page"], "file": hit["file"],
                            "bytes": len(data)})
        index[d["id"]] = got
        print(f"  {d['id']:<12} {got} scene photos", flush=True)
    json.dump(index, open(os.path.join(SCRATCH, "scene_index.json"), "w"), indent=1)
    json.dump(credits, open(os.path.join(SCRATCH, "results_scene.json"), "w"), indent=1)
    print(f"\n{sum(index.values())} scene photos across {len(index)} destinations")

main()
