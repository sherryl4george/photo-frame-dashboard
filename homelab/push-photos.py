#!/usr/bin/env python3
"""Copy a photo folder from this computer to the frame server's drop folder.

The server imports what lands there within about 5 minutes (a systemd timer runs importer.py --mirror).
With --delete, photos that are no longer in your folder are removed from the server's drop folder too,
and the importer then removes them from the frame. Nothing in YOUR folder is ever changed.

  ./push-photos.py ~/Pictures/frame                 # add new / changed photos
  ./push-photos.py ~/Pictures/frame --delete        # make the server's folder match yours
  ./push-photos.py ~/Pictures/frame --dry-run

Needs ssh access to the server (key login) and `tar` on both ends. No rsync needed.
The server comes from --host, $FRAME_HOST, or the first line of ~/.config/photoframe/host (kept out of git).
"""
import argparse, os, shlex, subprocess, sys

EXTS = {".jpg", ".jpeg", ".png"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--host", help="user@server (default: $FRAME_HOST, or the first line of ~/.config/photoframe/host)")
    ap.add_argument("--remote", default="/opt/photoframe/incoming")
    ap.add_argument("--delete", action="store_true", help="remove server-side photos that are not in the folder")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if not a.host:
        a.host = os.environ.get("FRAME_HOST", "")
        cfg = os.path.expanduser("~/.config/photoframe/host")
        if not a.host and os.path.exists(cfg):
            a.host = open(cfg).readline().strip()
    if not a.host:
        sys.exit("no server given: use --host user@server, set FRAME_HOST, or put it in ~/.config/photoframe/host")

    local = {}
    for r, _, fs in os.walk(a.folder):
        for f in fs:
            if os.path.splitext(f)[1].lower() in EXTS:
                p = os.path.join(r, f)
                local[os.path.relpath(p, a.folder)] = os.path.getsize(p)
    if not local:
        sys.exit("no photos found in %s; refusing to continue" % a.folder)

    out = subprocess.run(["ssh", a.host, "find %s -type f -printf '%%P\\t%%s\\n'" % shlex.quote(a.remote)],
                         capture_output=True, text=True, check=True).stdout
    remote = {}
    for line in out.splitlines():
        name, _, size = line.rpartition("\t")
        if os.path.splitext(name)[1].lower() in EXTS:
            remote[name] = int(size)

    send = sorted(n for n, s in local.items() if remote.get(n) != s)
    extra = sorted(set(remote) - set(local))
    print("local %d photos, server %d: to send %d%s" % (len(local), len(remote), len(send),
          ", to delete %d" % len(extra) if a.delete else (" (%d extra on the server, kept; use --delete)" % len(extra) if extra else "")))
    if a.dry_run:
        for n in send: print("  send", n)
        if a.delete:
            for n in extra: print("  delete", n)
        return
    if send:
        tar = subprocess.Popen(["tar", "-C", a.folder, "-cf", "-", "-T", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        ssh = subprocess.Popen(["ssh", a.host, "mkdir -p %s && tar -xf - -C %s" % (shlex.quote(a.remote), shlex.quote(a.remote))], stdin=tar.stdout)
        tar.stdout.close()
        tar.stdin.write(("\n".join(send) + "\n").encode()); tar.stdin.close()
        if ssh.wait() or tar.wait():
            sys.exit("transfer failed")
    if a.delete and extra:
        names = "\0".join(extra).encode()
        subprocess.run(["ssh", a.host, "cd %s && xargs -0 rm -f --" % shlex.quote(a.remote)], input=names, check=True)
    print("done; the frame picks it up within about 5 minutes")


if __name__ == "__main__":
    main()
