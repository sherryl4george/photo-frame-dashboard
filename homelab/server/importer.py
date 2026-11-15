#!/usr/bin/env python3
"""Keep the frame's photo library in step with a drop folder.

Every run it:
  * adds new JPEG/PNG files: rotates them upright, converts them to sRGB (phones often tag
    Display-P3, which looks washed out if the tag is simply dropped), adds a mild "punch" for the
    panel, writes full / small / bg (tiny, pre-blurred) JPEGs with no EXIF, reads the date taken and
    GPS from the original, and names the place offline (geo.py);
  * with --mirror, removes the library copies of photos that are no longer in the folder
    (the originals in the folder are never touched);
  * redoes the copies of photos made by an older version of this pipeline (PROC_VERSION).

Safe to run every few minutes: originals are identified by SHA-256 and cached by size+mtime.

  python3 importer.py --incoming /opt/photoframe/incoming --data /opt/photoframe/data --mirror
"""
import argparse, calendar, fcntl, hashlib, io, os, re, sqlite3, sys, time
from datetime import datetime

from PIL import Image, ImageCms, ImageEnhance, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # our own geo.py, even when run with python -I
import geo

PROC_VERSION = 2          # bump when the way copies are made changes
EXTS = {".jpg", ".jpeg", ".png"}
NEIGHBOUR_S = 3 * 3600
SATURATION, CONTRAST = 1.10, 1.04   # panel "punch"; override with --saturation / --contrast
SRGB = ImageCms.createProfile("sRGB")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_meta(im, path):
    """(date 'YYYY-MM-DD', taken_ts, lat, lon). Date: EXIF, else a date in the file name, else mtime."""
    ex = im.getexif()
    raw = ex.get_ifd(0x8769).get(0x9003) or ex.get(0x0132)
    dt = None
    if raw:
        try:
            dt = datetime.strptime(str(raw).strip()[:19], "%Y:%m:%d %H:%M:%S")
        except ValueError:
            dt = None
    if dt is None:
        m = re.search(r"(20\d{2})(\d{2})(\d{2})", os.path.basename(path))
        if m:
            try:
                dt = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 12)
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


def to_srgb(im, icc):
    """Convert from the embedded profile to sRGB. No profile means it already is sRGB."""
    if not icc:
        return im
    try:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        if ImageCms.getProfileDescription(src).strip().lower().startswith("srgb"):
            return im
        return ImageCms.profileToProfile(im, src, SRGB, renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode="RGB")
    except Exception as e:  # a broken profile must not lose the photo
        print("  (colour profile ignored: %s)" % e, file=sys.stderr)
        return im


def display_copy(im, sat, con):
    if sat != 1.0: im = ImageEnhance.Color(im).enhance(sat)
    if con != 1.0: im = ImageEnhance.Contrast(im).enhance(con)
    return im


def save_jpeg(im, path, quality, sharpen=True):
    if sharpen:
        im = im.filter(ImageFilter.UnsharpMask(radius=0.8, percent=30, threshold=2))
    tmp = path + ".part"
    im.save(tmp, "JPEG", quality=quality, subsampling=0, optimize=True, progressive=True)  # no exif/icc written
    os.replace(tmp, path)


def shrunk(im, box):
    im = im.copy()
    im.thumbnail(box, Image.LANCZOS)
    return im


def make_copies(data, pid, im, icc, o, sat, con):
    """Shrink first, then colour-convert and add punch: same result, a fraction of the work."""
    big, small = ((1920, 1440), (960, 720)) if o == "l" else ((1080, 1440), (540, 720))
    base = display_copy(to_srgb(shrunk(im, big), icc), sat, con)
    save_jpeg(base, os.path.join(data, "photos", "full", pid + ".jpg"), 92)
    save_jpeg(shrunk(base, small), os.path.join(data, "photos", "small", pid + ".jpg"), 85)
    save_jpeg(shrunk(base, (48, 48)).filter(ImageFilter.GaussianBlur(1.5)), os.path.join(data, "photos", "bg", pid + ".jpg"), 70, sharpen=False)


def load_upright(path):
    with Image.open(path) as im0:
        icc = im0.info.get("icc_profile")
        meta = read_meta(im0, path)
        if im0.format == "JPEG":
            im0.draft("RGB", (1440, 1440))  # decode at 1/2 size when the original is big: still >= the largest copy we write
        im = ImageOps.exif_transpose(im0).convert("RGB")
    return im, icc, meta


def scan(db, folder):
    """{hash: path} for every image in folder; hashes are cached by size+mtime."""
    found = {}
    for r, _, fs in os.walk(folder):
        for f in sorted(fs):
            if os.path.splitext(f)[1].lower() not in EXTS:
                continue
            p = os.path.join(r, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            row = db.execute("SELECT size, mtime_ns, hash FROM src_files WHERE path=?", (p,)).fetchone()
            if row and row[0] == st.st_size and row[1] == st.st_mtime_ns:
                h = row[2]
            else:
                h = sha256(p)
                db.execute("INSERT OR REPLACE INTO src_files (path,size,mtime_ns,hash) VALUES (?,?,?,?)", (p, st.st_size, st.st_mtime_ns, h))
            found.setdefault(h, p)
    db.execute("DELETE FROM src_files WHERE path NOT LIKE ?", (folder.rstrip("/") + "/%",))
    db.commit()
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--incoming", required=True)
    ap.add_argument("--data", required=True, help="folder holding photoframe.db and photos/")
    ap.add_argument("--geo", help="GeoNames folder (default: <data>/geonames)")
    ap.add_argument("--no-geo", action="store_true", help="skip place names")
    ap.add_argument("--mirror", action="store_true", help="remove library photos whose original left the folder")
    ap.add_argument("--force-mirror", action="store_true", help="allow --mirror to remove more than half the library")
    ap.add_argument("--saturation", type=float, default=SATURATION)
    ap.add_argument("--contrast", type=float, default=CONTRAST)
    ap.add_argument("--reprocess-all", action="store_true", help="redo every copy from the originals (after changing --saturation/--contrast)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    os.makedirs(a.data, exist_ok=True)
    lock = open(os.path.join(a.data, ".import.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another import is running; skipping")
        return 0

    db = sqlite3.connect(os.path.join(a.data, "photoframe.db"))
    db.executescript(open(os.path.join(HERE, "schema.sql")).read())
    cols = {r[1] for r in db.execute("PRAGMA table_info(photos)")}
    if "proc_ver" not in cols:
        db.execute("ALTER TABLE photos ADD COLUMN proc_ver INTEGER NOT NULL DEFAULT 0")
    for d in ("full", "small", "bg"):
        os.makedirs(os.path.join(a.data, "photos", d), exist_ok=True)
    if a.reprocess_all and not a.dry_run:
        db.execute("UPDATE photos SET proc_ver = 0")
        db.commit()

    sources = scan(db, a.incoming)
    rows = {r[0]: (r[1], r[2]) for r in db.execute("SELECT src_hash, id, proc_ver FROM photos")}
    todo_new = [(h, p) for h, p in sorted(sources.items(), key=lambda kv: kv[1]) if h not in rows]
    todo_redo = [(h, sources[h]) for h, (pid, v) in rows.items() if h in sources and v < PROC_VERSION]
    stale = [(h, pid) for h, (pid, v) in rows.items() if h not in sources]
    places = None
    added = redone = failed = removed = 0

    for h, path in todo_new:
        try:
            im, icc, (date, ts, lat, lon) = load_upright(path)
            pid = h[:16]
            if places is None and not a.no_geo and lat is not None:
                places = geo.Places(a.geo or os.path.join(a.data, "geonames"))
            place, pf = "", ""
            if lat is not None and places:
                place, pf = places.nearest(lat, lon), "gps"
                if not place: pf = ""
            o = "p" if im.height > im.width else "l"
            print("add  %-34s %s %s %s %s" % (os.path.basename(path)[:34], date, o, place or "-", "(no GPS)" if lat is None else ""))
            if not a.dry_run:
                make_copies(a.data, pid, im, icc, o, a.saturation, a.contrast)
                db.execute("INSERT INTO photos (id,o,date,place,fav,created_at,taken_ts,lat,lon,place_from,src_hash,src_name,proc_ver) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?)",
                           (pid, o, date, place, int(time.time() * 1000), ts,
                            None if lat is None else round(lat, 2), None if lon is None else round(lon, 2), pf, h, os.path.basename(path), PROC_VERSION))
                db.commit()
            added += 1
        except Exception as e:  # one bad file must not stop the batch
            failed += 1
            print("FAILED %s: %s" % (os.path.basename(path), e), file=sys.stderr)

    for h, path in todo_redo:
        try:
            im, icc, _ = load_upright(path)
            pid = rows[h][0]
            if not a.dry_run:
                make_copies(a.data, pid, im, icc, "p" if im.height > im.width else "l", a.saturation, a.contrast)
                db.execute("UPDATE photos SET proc_ver=? WHERE id=?", (PROC_VERSION, pid))
                db.commit()
            redone += 1
        except Exception as e:
            failed += 1
            print("FAILED redo %s: %s" % (os.path.basename(path), e), file=sys.stderr)

    if a.mirror and stale:
        if not sources:
            print("mirror skipped: the incoming folder has no photos (empty or not mounted?)", file=sys.stderr)
        elif len(stale) > max(5, len(rows) // 2) and not a.force_mirror:
            print("mirror skipped: it would remove %d of %d photos; rerun with --force-mirror if that is intended" % (len(stale), len(rows)), file=sys.stderr)
            failed += 1
        else:
            for h, pid in stale:
                print("del  %s" % pid)
                if not a.dry_run:
                    for k in ("full", "small", "bg"):
                        try: os.remove(os.path.join(a.data, "photos", k, pid + ".jpg"))
                        except FileNotFoundError: pass
                    db.execute("DELETE FROM photos WHERE id=?", (pid,))
                removed += 1
            db.commit()

    borrowed = 0
    if not a.dry_run and (added or removed):
        have = db.execute("SELECT taken_ts, place FROM photos WHERE place_from='gps' AND place!='' AND taken_ts IS NOT NULL").fetchall()
        for pid, ts in db.execute("SELECT id, taken_ts FROM photos WHERE place='' AND taken_ts IS NOT NULL").fetchall():
            best = min(have, key=lambda r: abs(r[0] - ts), default=None)
            if best and abs(best[0] - ts) <= NEIGHBOUR_S:
                db.execute("UPDATE photos SET place=?, place_from='neighbour' WHERE id=?", (best[1], pid))
                borrowed += 1
        db.commit()
    if added or redone or removed or failed or borrowed:
        print("added %d, redone %d, removed %d, failed %d, place borrowed %d, library now %d%s" % (
            added, redone, removed, failed, borrowed, db.execute("SELECT count(*) FROM photos").fetchone()[0], " (dry run)" if a.dry_run else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
