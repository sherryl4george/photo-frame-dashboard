"""Offline "approximate place" lookup: the nearest populated place in GeoNames cities1000.

No coordinates leave the machine. GeoNames data is CC BY 4.0 (https://www.geonames.org).
"""
import hashlib, io, json, math, os, urllib.request, zipfile

BASE = "https://download.geonames.org/export/dump/"
FILES = {"cities1000.zip": "cities1000.txt", "admin1CodesASCII.txt": None}


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_data(folder):
    """Download once; record SHA-256 in geonames.lock.json and verify on every later start.
    (GeoNames re-publishes these files daily, so there is no fixed upstream hash to pin.)"""
    os.makedirs(folder, exist_ok=True)
    lock_path = os.path.join(folder, "geonames.lock.json")
    lock = json.load(open(lock_path)) if os.path.exists(lock_path) else {}
    for name in FILES:
        path = os.path.join(folder, name)
        if not os.path.exists(path):
            with urllib.request.urlopen(BASE + name, timeout=120) as r, open(path + ".part", "wb") as f:
                f.write(r.read())
            os.replace(path + ".part", path)
            lock[name] = _sha256(path)
            json.dump(lock, open(lock_path, "w"), indent=1)
        elif lock.get(name) and lock[name] != _sha256(path):
            raise SystemExit("geonames file changed since it was downloaded: " + name)
    return folder


class Places:
    def __init__(self, folder):
        ensure_data(folder)
        admin = {}
        with open(os.path.join(folder, "admin1CodesASCII.txt"), encoding="utf-8") as f:
            for line in f:
                code, name = line.split("\t")[:2]
                admin[code] = name
        self.grid = {}
        with zipfile.ZipFile(os.path.join(folder, "cities1000.zip")) as z:
            data = io.TextIOWrapper(z.open("cities1000.txt"), encoding="utf-8")
            for line in data:
                c = line.rstrip("\n").split("\t")
                lat, lon, cc, a1 = float(c[4]), float(c[5]), c[8], c[10]
                region = a1 if cc == "US" else admin.get(cc + "." + a1, "") or cc
                self.grid.setdefault((int(math.floor(lat)), int(math.floor(lon))), []).append((lat, lon, c[2] or c[1], region))

    @staticmethod
    def _km(lat1, lon1, lat2, lon2):
        p = math.pi / 180
        a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
        return 12742 * math.asin(math.sqrt(a))

    def nearest(self, lat, lon, max_km=60):
        """'Issaquah, WA' for the nearest populated place within max_km, else ''."""
        best, bd = None, max_km
        la, lo = int(math.floor(lat)), int(math.floor(lon))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for plat, plon, name, region in self.grid.get((la + dy, lo + dx), ()):
                    d = self._km(lat, lon, plat, plon)
                    if d < bd:
                        best, bd = (name, region), d
        return "%s, %s" % best if best else ""
