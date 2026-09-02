#!/usr/bin/env python3
"""Import real photography for TripFlow's curated destinations and places.

Searches Wikipedia for each destination/place, picks the best-matching article's lead
photo (scored for relevance, with logos/flags/maps/diagrams rejected), re-encodes it to a
web-sized progressive JPEG, and records the author + licence for CREDITS.md.

A target with no confidently-matching photo is left MISSING on purpose rather than filled
with a loosely-related image — the app already falls back to its placeholder and live
lookup for those.
"""
import json, os, sys, io, re, time, math, unicodedata, urllib.parse, urllib.request, urllib.error
import concurrent.futures, threading, difflib
from PIL import Image, ImageOps
from collections import Counter

UA = "TripFlow-image-import/1.0 (static travel demo site; contact: jiewei190@gmail.com)"
API = "https://en.wikipedia.org/w/api.php"
HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ.get("TRIPFLOW_WORK", os.path.join(HERE, ".work"))
os.makedirs(SCRATCH, exist_ok=True)
ROOT = os.path.dirname(HERE)

# Files that are graphics, not photographs of the place.
BAD_FILE = re.compile(r"(logo|flag|\bmap\b|coat[_ ]of[_ ]arms|seal|emblem|wordmark|icon|"
                      r"banner|location|locator|blank|outline|chart|diagram|graph)", re.I)
# Article titles that are never a place we want a photo of.
# A destination hero must sell the place. Its airport, bus station or hospital is genuinely
# located there and genuinely photographed, but it is not what makes anyone want to go.
HERO_AVOID = re.compile(r"(airport|airfield|air base|railway station|bus station|terminal|"
                        r"stadium|hospital|university|college|prison|power station|"
                        r"parliament|embassy|barracks|cemetery)", re.I)
BAD_TITLE = re.compile(r"(disambiguation|^list of|discography|filmography|\(surname\)|\(name\)|"
                       r"bombing|attack|massacre|earthquake|tsunami|disaster|\bwar\b|riot|shooting|"
                       r"murder|crash|protest|election|scandal|outbreak|pandemic|genocide|siege)", re.I)
_lock = threading.Lock()
_throttle = threading.Semaphore(3)
_last = [0.0]

def norm(s):
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s).strip()

def toks(s):
    return [t for t in norm(s).split() if t]

def api(params, tries=6):
    params = dict(params); params["format"] = "json"
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    for i in range(tries):
        with _throttle:
            # Wikipedia rate-limits anonymous callers hard; keep a global minimum gap.
            gap = 0.35 - (time.time() - _last[0])
            if gap > 0: time.sleep(gap)
            _last[0] = time.time()
            try:
                with urllib.request.urlopen(req, timeout=40) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code in (429, 503): time.sleep(1.5 * (2 ** i)); continue
                return {}
            except Exception:
                time.sleep(1.0 * (i + 1)); continue
    return {}

GENERIC_HEAD = {"hotel","hostel","hostal","restaurant","cafe","bar","museum","temple","shrine",
                "park","garden","gardens","palace","church","cathedral","market","beach","bridge",
                "tower","gallery","centre","center","square","street","house","the","grand",
                "royal","old","new","city","national","villa","casa","club","resort","inn"}

def haversine(a_lat, a_lng, b_lat, b_lng):
    R = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lng - a_lng)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))

def same_token(a, b):
    """Token equality that tolerates transliteration spelling ("Marrakech"/"Marrakesh")."""
    if a == b: return True
    if len(a) >= 5 and len(b) >= 5 and abs(len(a) - len(b)) <= 2:
        return difflib.SequenceMatcher(None, a, b).ratio() >= 0.85
    return False

def overlap(tt, lt):
    used, n = set(), 0
    for a in lt:
        for i, b in enumerate(tt):
            if i in used: continue
            if same_token(a, b): used.add(i); n += 1; break
    return n

def core_title(title):
    """Drop a trailing geographic qualifier: "Queenstown, New Zealand" -> "Queenstown".

    Wikipedia disambiguates place articles with a ", <region>" suffix. Counting that suffix as
    extra words made the CORRECT article score worse than a wrong-but-shorter neighbour --
    "Queenstown, New Zealand" lost to "Queenstown Airport". The suffix is disambiguation, not
    part of the name, so it is scored separately (below) rather than as a mismatch.
    """
    return title.split(",")[0], (title.split(",", 1)[1] if "," in title else "")

def score(title, label, dest):
    """How confidently does this article title name the thing we asked for?

    Symmetric (F1) token overlap, so a title that ADDS a contradicting word is penalised as
    much as one that drops a word: for "Meiji Jingu Shrine", "Meiji Shrine" (0.80) correctly
    beats "Meiji Jingu Stadium" (0.67). Type words like Shrine/Stadium are deliberately kept
    in the comparison -- they are exactly what distinguishes the right article from the wrong one.
    """
    if BAD_TITLE.search(title): return -1
    head, qualifier = core_title(title)
    tt, lt = toks(head), toks(label)
    if not tt or not lt: return -1
    n = overlap(tt, lt)
    if not n: return -1
    prec, rec = n / len(tt), n / len(lt)
    s = int(100 * (2 * prec * rec) / (prec + rec))
    # A shared distinctive head word ("Kappabashi-dori" for "Kappabashi Kitchen Town") is a
    # much stronger signal than raw overlap suggests -- but only for a real name, never for a
    # generic type word, which matched "Hotel Borg" to "Hotel Foroyar".
    if tt and lt and same_token(tt[0], lt[0]) and len(lt[0]) >= 5 and lt[0] not in GENERIC_HEAD:
        s += 25
    if dest and overlap(toks(qualifier) + tt, toks(dest)): s += 8   # "Shibuya, Tokyo" beats "Shibuya, Idaho"
    return s

def candidates(query, label, dest, width, min_score, lat=None, lng=None, radius_km=None,
               avoid=None):
    """Best article whose lead image really depicts what we asked for.

    Title similarity alone matched "The Ludlow Hotel" (New York) to a pub in Shropshire and
    "Hotel Borg" (Reykjavik) to one in the Faroes. Wikipedia knows where its subjects are, so
    the decisive filter is geographic: a candidate must sit within `radius_km` of the real
    place. Articles with no coordinates at all ("Sushi", "Hyatt", "Gothic architecture") are
    abstractions rather than places, and are rejected on the same test.
    """
    d = api({"action": "query", "generator": "search", "gsrsearch": query, "gsrlimit": 8,
             "prop": "pageimages|coordinates", "piprop": "thumbnail|name",
             "pithumbsize": width, "colimit": 50})
    ranked = []
    for p in ((d.get("query") or {}).get("pages") or {}).values():
        thumb = (p.get("thumbnail") or {}).get("source")
        fname = p.get("pageimage") or ""
        if not thumb or not fname: continue
        # Locator maps, flags and logos are the commonest lead image for a region article.
        if fname.lower().endswith(".svg") or BAD_FILE.search(fname): continue
        if radius_km is not None:
            co = (p.get("coordinates") or [{}])[0]
            if co.get("lat") is None: continue
            if haversine(lat, lng, co["lat"], co["lon"]) > radius_km: continue
        if avoid and avoid.search(p.get("title", "")): continue
        sc = score(p.get("title", ""), label, dest)
        if sc < min_score: continue
        sc -= p.get("index", 9)                       # tie-break toward Wikipedia's own ranking
        ranked.append((sc, {"thumb": thumb, "file": fname, "page": p.get("title")}))
    ranked.sort(key=lambda x: -x[0])
    return [c for _, c in ranked]

def encode(raw, tw, th, quality):
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    if im.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", im.size, (232, 236, 234))
        im = im.convert("RGBA"); bg.paste(im, mask=im.split()[-1]); im = bg
    else:
        im = im.convert("RGB")
    sw, sh = im.size
    scale = max(tw / sw, th / sh)
    if scale < 1:                                  # never upscale a small original
        im = im.resize((max(1, round(sw * scale)), max(1, round(sh * scale))), Image.LANCZOS)
    sw, sh = im.size
    if sw > tw or sh > th:                         # centre cover-crop to the card aspect
        l, t = (sw - tw) // 2, (sh - th) // 2
        im = im.crop((max(0, l), max(0, t), max(0, l) + min(tw, sw), max(0, t) + min(th, sh)))
    flat = is_flat_graphic(im)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue(), im.size, flat

# kind -> (width, height, jpeg quality, min title score, geographic radius km)
# The hero radius is generous because a "destination" can be a whole region (Bali, Santorini)
# whose most representative photo is a landmark well outside the centre point.
# A dish or cuisine is not a place, so it has no coordinates to check and is geofenced to
# None; its query is a curated article name, so an exact title match is demanded instead.
def is_flat_graphic(im):
    """True for maps, diagrams and charts that no filename filter can catch.

    Santorini's own article leads with "2011_Dimos_Thiras.png", a municipality map — nothing
    in that name says "map", and it is a PNG so the SVG filter misses it too. Pixels give it
    away: a photograph carries hundreds of distinct colours with no single one dominating,
    while a map is a handful of flat fills over one background.
    """
    small = im.convert("RGB").resize((72, 72), Image.BILINEAR)
    px = list(small.getdata())
    post = [(r >> 4, g >> 4, b >> 4) for r, g, b in px]
    uniq = len(set(post))
    dominant = Counter(post).most_common(1)[0][1] / len(post)
    return uniq < 40 or dominant > 0.62 or (uniq < 90 and dominant > 0.45)

SPECS = {"hero": (1280, 720, 78, 70, 200), "attraction": (640, 480, 76, 58, 60),
         "restaurant": (640, 480, 76, 58, 60), "hotel": (640, 480, 76, 58, 60),
         "cuisine": (640, 480, 78, 75, None)}

def handle(t):
    tw, th, q, min_score, radius = SPECS[t["kind"]]
    for tier in t["tiers"]:
        # The last-resort country tier is deliberately not geofenced to a city radius.
        rad = None if tier.get("anywhere") else radius
        for hit in candidates(tier["q"], tier["label"], tier.get("dest"), tw, min_score,
                              t.get("lat"), t.get("lng"), rad,
                              HERO_AVOID if t["kind"] == "hero" else None):
            try:
                req = urllib.request.Request(hit["thumb"], headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=60) as r: raw = r.read()
                data, size, flat = encode(raw, tw, th, q)
            except Exception:
                continue
            # A photograph of a real place is never this small at this size, and never this
            # flat; either way it is a graphic, so try the next candidate rather than shipping it.
            if len(data) < 14000 or flat:
                with _lock: print(f"  skip {t['key']:<26} graphic: {hit['file'][:38]}", flush=True)
                continue
            break
        else:
            continue
        path = os.path.join(ROOT, "images", t["key"] + ".jpg")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f: f.write(data)
        with _lock: print(f"  ok   {t['key']:<26} {len(data)//1024:>4}KB {t['label'][:26]:<26} <- {hit['page'][:30]}", flush=True)
        return {"key": t["key"], "label": t["label"], "kind": t["kind"], "matched_query": tier["q"],
                "tier_label": tier["label"],
                "wiki_page": hit["page"], "file": hit["file"], "bytes": len(data),
                "w": size[0], "h": size[1]}
    with _lock: print(f"  MISS {t['key']:<26}      {t['label'][:26]}", flush=True)
    return {"key": t["key"], "label": t["label"], "kind": t["kind"], "missing": True}

def add_credits(results):
    """Batch-fetch author/licence for every file actually used."""
    files = sorted({r["file"] for r in results if not r.get("missing")})
    meta = {}
    for i in range(0, len(files), 25):
        chunk = files[i:i + 25]
        d = api({"action": "query", "titles": "|".join("File:" + f for f in chunk),
                 "prop": "imageinfo", "iiprop": "extmetadata|url"})
        for p in ((d.get("query") or {}).get("pages") or {}).values():
            ii = (p.get("imageinfo") or [{}])[0]
            em = ii.get("extmetadata") or {}
            def g(k):
                v = (em.get(k) or {}).get("value") or ""
                return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", v)).strip()
            meta[re.sub(r"^File:", "", p.get("title", ""))] = {
                "author": g("Artist") or "Unknown",
                "license": g("LicenseShortName") or "See file page",
                "license_url": g("LicenseUrl"),
                "file_page": ii.get("descriptionurl") or "",
            }
        print(f"  credits {min(i+25, len(files))}/{len(files)}", flush=True)
    for r in results:
        if not r.get("missing"):
            r.update(meta.get(r["file"], {}))
    return results

def main():
    manifest = "manifest.json"
    results_name = "results.json"
    for a in sys.argv[1:]:
        if a.startswith("--manifest="):
            manifest = a.split("=", 1)[1]
            results_name = manifest.replace("manifest", "results")
    targets = json.load(open(os.path.join(SCRATCH, manifest)))
    if "--sample" in sys.argv:
        want = {"dest/queenstown","dest/marrakech","dest/bali","dest/tokyo",
                "place/barcelona-a3","place/barcelona-a5","place/new-york-a1","place/new-york-h2",
                "place/reykjavik-h1","place/rome-h1","place/ljubljana-h3","place/tokyo-h3",
                "place/queenstown-a2","place/tokyo-a3","place/tokyo-a6","place/tokyo-r3"}
        targets = [t for t in targets if t["key"] in want]
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(handle, targets))
    results = add_credits(results)
    json.dump(results, open(os.path.join(SCRATCH, results_name), "w"), indent=1)
    ok = [r for r in results if not r.get("missing")]
    print(f"\n{len(ok)}/{len(results)} resolved · {sum(r['bytes'] for r in ok)/1048576:.1f} MB")

main()
