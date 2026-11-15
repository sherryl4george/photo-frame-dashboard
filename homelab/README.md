# Home HQ on a homelab server

Runs the dashboard from a small Node service instead of Cloudflare, with photos and weather first.
No Docker, no npm packages on the server. Front end: a trimmed copy of
[sambartle/photo-frame-dashboard](https://github.com/sambartle/photo-frame-dashboard) (see [NOTICE.md](NOTICE.md)).

```
Google Photos zip ── scp ──▶ server:/opt/photoframe/drop/  ──▶ incoming/album/   (also: push-photos.py ──▶ incoming/)
                                   │  importer.py --drop --mirror, every 5 minutes (systemd timer)
                                   ▼
                              data/photoframe.db + data/photos/{full,small,bg}/
                                   │
frame (Home HQ kiosk) ◀── http://<server>:8080/?key=… ── server/server.mjs (systemd service)
```

| Piece | What it does |
| --- | --- |
| `app/` | The dashboard page. `npm install && npx vite build` makes `app/dist/`, which goes to `<server>/app/`. |
| `server/server.mjs` | Node 22+ (built-in SQLite). Serves the page and `/api/*`: photos, Open-Meteo weather, shopping list, notes, frame check-ins. Calendar and Home Assistant answer "nothing configured". |
| `server/importer.py` | Python + Pillow. Adds, redoes and (with `--mirror`) removes photos. |
| `server/geo.py` | Offline "approximate place" from GPS, using GeoNames `cities1000` (CC BY 4.0, https://www.geonames.org). |
| `push-photos.py` | Copies a folder on your computer to the server's `incoming/`. No rsync needed. |

## Updating photos from Google Photos (the usual way)

1. In Google Photos, open your album and choose **Download all**. You get one or more zip files.
2. Copy the zip(s) to the server's `drop/` folder:

   ```sh
   scp ~/Downloads/Frameo-*.zip <user>@<server>:/opt/photoframe/drop/
   ```

3. Wait about 5 to 10 minutes. The server waits until nothing in `drop/` has changed for 5 minutes (so a copy still
   in progress, or a multi-part download, is never read half-way), then unpacks the zip(s) into `incoming/album/`,
   moves them to `drop/done/` (kept 14 days) and imports the photos. The frame shows them on its next poll.

**Each download is a full snapshot of the album.** New photos are added; photos you removed from the album are
removed from the frame (the importer's mirror mode); photos already imported are left alone (identified by SHA-256,
so re-downloading the same album costs almost nothing). Put every part of a multi-part download in `drop/` together.
A damaged zip, or one with no photos, changes nothing and stays in `drop/` (the reason is in the journal).
Only image files are used, by base name, so nothing in a zip can write outside the server's own folders.

## Other ways to add photos

```sh
./push-photos.py ~/Pictures/frame             # add new or changed photos from a folder on this computer
./push-photos.py ~/Pictures/frame --delete    # also remove ones you deleted locally
./push-photos.py ~/Pictures/frame --dry-run   # see what it would do
```

This goes to `incoming/` (not `incoming/album/`), so it is a separate set from the album: mirroring
removes a photo only when it is in neither place. Mirror refuses to run when there are no source photos or when it would
remove more than half the library (so a wrong or half-copied snapshot can't wipe it). To replace most of the set on
purpose, run once by hand:

```sh
ssh <user>@<server> 'python3 -I /opt/photoframe/server/importer.py --incoming /opt/photoframe/incoming --data /opt/photoframe/data --drop /opt/photoframe/drop --mirror --force-mirror'
```

Per photo the importer: rotates upright, **converts the embedded colour profile to sRGB** (phones tag
Display-P3; dropping the tag makes photos look washed out), adds a mild "punch" for this panel
(`--saturation 1.10 --contrast 1.04`), writes JPEGs with no EXIF (`full` up to 1920x1440, `small`, and a tiny
pre-blurred `bg` shown behind portraits), reads the date from EXIF (else the file name, else the file time),
and names the place from GPS (a photo with no GPS borrows the place of one taken within 3 hours).
Lat/lon are stored rounded to about 1 km and never sent to the page. Originals are never modified.
After changing the punch level, add `--reprocess-all` to the importer command once.

## On the server

`/opt/photoframe`: `node/` (portable Node 24, SHA-256 checked), `app/`, `server/`, `config/` (settings.json,
secrets.json with the dashboard key, mode 600, never committed), `data/`, `incoming/`.
User systemd units (`~/.config/systemd/user/`, lingering on): `photoframe.service` (the server, port 8080,
sandboxed: it can only write `data/`), `photoframe-import.service` and `.timer` (every 5 minutes).

```sh
systemctl --user status photoframe.service photoframe-import.timer
journalctl --user -u photoframe-import.service --since today
```

## Pointing the frame at it, and undoing it

```sh
adb shell am start -n com.wesbos.homehq/.MainActivity --es url 'http://<server-ip>:8080/?key=<DASHBOARD_KEY>'
```

To go back to the page bundled in the APK: `... --es url 'http://127.0.0.1:8765/'`.
The page is plain HTTP on the LAN, so the key travels unencrypted inside your network; keep the server off
the internet. The frame and the server must be on networks that can reach each other.
