#!/usr/bin/env python3
"""Import photos from a drop folder into the frame's library.

For every new JPEG/PNG in --incoming it:
  * rotates it upright from the EXIF orientation,
  * writes full (<=1920 px), small (<=960 px) and bg (tiny, pre-blurred) JPEGs with no EXIF,
  * reads the date taken and the GPS position from the original EXIF,
  * turns the position into an approximate place offline (see geo.py),
  * records it all in SQLite. A photo with no GPS borrows the place of one taken within 3 hours.

Re-running is safe: originals are identified by SHA-256, so nothing is imported twice.
The original files are never modified or deleted.

  python3 importer.py --incoming /opt/photoframe/incoming --data /opt/photoframe/data [--dry-run]
"""
import argparse, calendar, hashlib, os, sqlite3, sys, time
from datetime import datetime

from PIL import Image, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # our own geo.py, even when run with python -I
import geo
EXTS = {".jpg", ".jpeg", ".png"}
NEIGHBOUR_S = 3 * 3600


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_meta(im, path):
    """(date 'YYYY-MM-DD', taken_ts, lat, lon) from EXIF; date falls back to the file's mtime."""
    ex = im.getexif()
    raw = ex.get_ifd(0x8769).get(0x9003) or ex.get(0x0132)
    dt = None
    if raw:
        try:
            dt = datetime.strptime(str(raw).strip()[:19], "%Y:%m:%d %H:%M:%S")
        except ValueError:
            dt = None
    if dt is None:
        dt = datetime.fromtimestamp(os.path.getmtime(path))
    lat = lon = None
    g = ex.get_ifd(0x8825)
    try:
        if g.get(2) and g.get(4):
            conv = lambda v: float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
            lat, lon = conv(g[2]), conv(g[4])
            if g.get(1) == "S": lat = -lat
            if g.get(3) == "W": lon = -lon
            if abs(lat) < 1e-6 and abs(lon) < 1e-6 or abs(lat) > 90 or abs(lon) > 180:
                lat = lon = None
    except (TypeError, ValueError, ZeroDivisionError, IndexError):
        lat = lon = None
    return dt.strftime("%Y-%m-%d"), calendar.timegm(dt.timetuple()), lat, lon


def save_jpeg(im, path, max_edge, quality, blur=0):
    im = im.copy()
    im.thumbnail((max_edge, max_edge), Image.LANCZOS)
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    tmp = path + ".part"
    im.save(tmp, "JPEG", quality=quality, optimize=True, progressive=True)  # no exif= -> none written
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--incoming", required=True)
    ap.add_argument("--data", required=True, help="folder holding photoframe.db and photos/")
    ap.add_argument("--geo", help="GeoNames folder (default: <data>/geonames)")
    ap.add_argument("--no-geo", action="store_true", help="skip place names")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    files = sorted(os.path.join(r, f) for r, _, fs in os.walk(a.incoming) for f in fs if os.path.splitext(f)[1].lower() in EXTS)
    os.makedirs(a.data, exist_ok=True)
    db = sqlite3.connect(os.path.join(a.data, "photoframe.db"))
    db.executescript(open(os.path.join(HERE, "schema.sql")).read())
    known = {r[0] for r in db.execute("SELECT src_hash FROM photos")}
    places = None if a.no_geo else geo.Places(a.geo or os.path.join(a.data, "geonames"))
    for d in ("full", "small", "bg"):
        os.makedirs(os.path.join(a.data, "photos", d), exist_ok=True)

    added = skipped = failed = 0
    for path in files:
        try:
            h = sha256(path)
            if h in known:
                skipped += 1
                continue
            with Image.open(path) as im0:
                im = ImageOps.exif_transpose(im0).convert("RGB")
                date, ts, lat, lon = read_meta(im0, path)
            pid = h[:16]
            place, pf = "", ""
            if lat is not None and places:
                place, pf = places.nearest(lat, lon), "gps"
                if not place: pf = ""
            o = "p" if im.height > im.width else "l"
            print("%-34s %s %s %s %s" % (os.path.basename(path)[:34], date, o, place or "-", "(no GPS)" if lat is None else ""))
            if not a.dry_run:
                save_jpeg(im, os.path.join(a.data, "photos", "full", pid + ".jpg"), 1920, 85)
                save_jpeg(im, os.path.join(a.data, "photos", "small", pid + ".jpg"), 960, 80)
                save_jpeg(im, os.path.join(a.data, "photos", "bg", pid + ".jpg"), 48, 70, blur=1.5)
                db.execute("INSERT INTO photos (id,o,date,place,fav,created_at,taken_ts,lat,lon,place_from,src_hash,src_name) VALUES (?,?,?,?,0,?,?,?,?,?,?,?)",
                           (pid, o, date, place, int(time.time() * 1000), ts,
                            None if lat is None else round(lat, 2), None if lon is None else round(lon, 2), pf, h, os.path.basename(path)))
                db.commit()
            known.add(h)
            added += 1
        except Exception as e:  # one bad file must not stop the batch
            failed += 1
            print("FAILED %s: %s" % (os.path.basename(path), e), file=sys.stderr)

    borrowed = 0
    if not a.dry_run:
        have = db.execute("SELECT taken_ts, place FROM photos WHERE place_from='gps' AND place!='' AND taken_ts IS NOT NULL").fetchall()
        for pid, ts in db.execute("SELECT id, taken_ts FROM photos WHERE place='' AND taken_ts IS NOT NULL").fetchall():
            best = min(have, key=lambda r: abs(r[0] - ts), default=None)
            if best and abs(best[0] - ts) <= NEIGHBOUR_S:
                db.execute("UPDATE photos SET place=?, place_from='neighbour' WHERE id=?", (best[1], pid))
                borrowed += 1
        db.commit()
    print("added %d, already had %d, failed %d, place borrowed from a nearby-in-time photo %d%s"
          % (added, skipped, failed, borrowed, " (dry run)" if a.dry_run else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
