#!/usr/bin/env python3
"""
rebuild.py  --  rebuild the Trunk-Caster containers and bring them back up.

Starts Docker Desktop if it is not answering, checks the crates locally first
(seconds), so a compile error never takes the running caster down, rebuilds the
Docker images, recreates the containers that are running, and waits for the
caster to answer on its API again. Can also publish the public page snapshot.

    python rebuild.py                rebuild and restart what is running now
    python rebuild.py --sims         ... with one simulator per protocol
    python rebuild.py --no-sims      caster only; stops any simulators
    python rebuild.py --sims-yml     regenerate docker-compose.sims.yml from the manuals first
    python rebuild.py --no-check     skip the local cargo check
    python rebuild.py --no-cache     build the images from scratch
    python rebuild.py --prune        drop the dangling images old builds leave behind
    python rebuild.py --open         open the pages in the browser once healthy
    python rebuild.py --logs         follow the caster log afterwards (Ctrl-C to stop)
    python rebuild.py --down         stop and remove everything instead
    python rebuild.py --publish      ... then push the static pages to the public GitHub Pages site
    python rebuild.py --publish-only publish the pages the caster already wrote; no rebuild
    python rebuild.py --dry-run      with --publish: list the pages instead of pushing them
    python rebuild.py --replay [N]   simulate N days (default 365) for the public site's replay;
                                     with --publish (or --publish-only) the pages then play it

Publishing needs the GitHub CLI (`gh`) signed in. The main repository stays
private: the static HTML the runtime writes into the TRUNK-* folders is copied,
its links rewritten so the pages point at each other, and pushed to a separate
public repository (--pages-repo, which has no default any more: the old
snapshot site was retired in APK.audio ROAD-3440) whose GitHub Pages site is
the public link. The pages checkout lives in `.pages/` (ignored by git).

The replay: `trunk-caster simulate` runs the caster headless for days of
simulated time with the demand in TRUNK-SIMULATOR/preview-fader.json, one
slice of days per CPU in parallel, into `.replay/` (ignored by git). When that
folder holds a year, publishing copies it to `replay/` on the site and every
page plays it back through the footer's Replay bar instead of a live stream.

Exit code is 0 when the caster is healthy again (or the pages were published), 1 otherwise.
"""
import argparse
import gzip
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
CRATES = ["RUST-RUNTIME", os.path.join("TRUNK-SIMULATOR", "frame-sim")]
SIMS_YML = os.path.join(ROOT, "docker-compose.sims.yml")
PAGES = pathlib.Path(ROOT) / ".pages"
REPLAY = pathlib.Path(ROOT) / ".replay"
PREVIEW_FADER = os.path.join(ROOT, "TRUNK-SIMULATOR", "preview-fader.json")
CASTER = "trunk-caster"
DEFAULT_URL = "http://127.0.0.1:8080"
DOCKER_START_TIMEOUT = 180   # seconds to give Docker Desktop to come up

T0 = time.time()


def log(msg):
    sys.stdout.write("%s %6.1fs  %s\n" % (time.strftime("%H:%M:%S"), time.time() - T0, msg))
    sys.stdout.flush()


def die(msg, code=1):
    log("FAILED: " + msg)
    sys.exit(code)


def run(args, capture=False, check=True, quiet=False, timeout=None):
    """Run a command in the project root. Returns stdout when captured."""
    if not quiet:
        log("$ " + " ".join(args))
    try:
        r = subprocess.run(
            args, cwd=ROOT,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except FileNotFoundError:
        die("%s is not on PATH" % args[0])
    except subprocess.TimeoutExpired:
        die("%s did not answer within %ds; Docker Desktop may be stuck (try: docker desktop restart)"
            % (" ".join(args[:2]), timeout))
    if check and r.returncode != 0:
        if capture and r.stderr:
            sys.stderr.write(r.stderr)
        die("%s exited with %d" % (args[0], r.returncode))
    return r.stdout if capture else r.returncode


def compose(*args, profile_sims=False, **kw):
    cmd = ["docker", "compose"]
    if profile_sims:
        cmd += ["--profile", "sims"]
    return run(cmd + list(args), **kw)


# ---------------------------------------------------------------------------
# Docker Desktop
# ---------------------------------------------------------------------------

def docker_answers(timeout=10):
    """True when the Docker engine answers `docker info` within the timeout."""
    try:
        r = subprocess.run(["docker", "info"], cwd=ROOT, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=timeout)
        return r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def desktop_process_running():
    """Is the Docker Desktop GUI already running? (Its engine can still be dead.)"""
    if sys.platform != "win32":
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Docker Desktop.exe", "/NH"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             encoding="utf-8", errors="replace", timeout=20).stdout
    except (subprocess.TimeoutExpired, OSError):
        return False
    return "Docker Desktop.exe" in out


def launch_desktop_app():
    """Fallback for Docker Desktop builds without the `docker desktop` CLI."""
    if sys.platform == "win32":
        for base in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                     os.environ.get("LOCALAPPDATA", "")):
            exe = os.path.join(base, "Docker", "Docker", "Docker Desktop.exe")
            if os.path.isfile(exe):
                log("launching " + exe)
                os.startfile(exe)
                return True
        return False
    if sys.platform == "darwin":
        return subprocess.run(["open", "-a", "Docker"]).returncode == 0
    return subprocess.run(["systemctl", "--user", "start", "docker-desktop"]).returncode == 0


def start_docker():
    """Bring the Docker engine up: start Docker Desktop, or restart it when its
    GUI is running but the engine (the docker-desktop WSL distro) has stopped."""
    verb = "restart" if desktop_process_running() else "start"
    log("the Docker engine is not answering; running `docker desktop %s`" % verb)
    try:
        r = subprocess.run(["docker", "desktop", verb], cwd=ROOT, timeout=DOCKER_START_TIMEOUT)
        ok = r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        ok = False
    if not ok:
        log("`docker desktop %s` did not work; launching the Docker Desktop app" % verb)
        if not launch_desktop_app():
            die("could not start Docker Desktop; start it by hand and run again")
    deadline = time.time() + DOCKER_START_TIMEOUT
    while time.time() < deadline:
        if docker_answers(timeout=15):
            log("Docker engine is up")
            return
        time.sleep(3)
    die("Docker Desktop did not come up within %ds; check its window, then run again"
        % DOCKER_START_TIMEOUT)


def preflight():
    if shutil.which("docker") is None:
        die("docker is not installed or not on PATH")
    if docker_answers():
        return
    start_docker()


# ---------------------------------------------------------------------------
# rebuild steps
# ---------------------------------------------------------------------------

def cargo_check():
    if shutil.which("cargo") is None:
        log("cargo not found on this machine; skipping the local check (Docker will compile)")
        return
    for crate in CRATES:
        path = os.path.join(ROOT, crate)
        if not os.path.isfile(os.path.join(path, "Cargo.toml")):
            log("no Cargo.toml in %s; skipping" % crate)
            continue
        log("cargo check  %s" % crate)
        r = subprocess.run(["cargo", "check", "--quiet"], cwd=path)
        if r.returncode != 0:
            die("%s does not compile; the containers were left as they are" % crate)
    log("crates compile")


def running_services():
    out = compose("ps", "--services", "--filter", "status=running",
                  profile_sims=True, capture=True, check=False, quiet=True, timeout=90) or ""
    return sorted(s.strip() for s in out.splitlines() if s.strip())


def sim_services():
    out = compose("config", "--services", profile_sims=True, capture=True, check=False, quiet=True,
                  timeout=90) or ""
    return sorted(s.strip() for s in out.splitlines() if s.strip().startswith("sim-"))


def decide_sims(args, running):
    if args.sims:
        return True
    if args.no_sims:
        return False
    sims_up = [s for s in running if s.startswith("sim-")]
    if sims_up:
        log("%d simulators are running; keeping them" % len(sims_up))
        return True
    log("no simulators running; rebuilding the caster only (use --sims to add them)")
    return False


def build(with_sims, no_cache):
    extra = ["--no-cache"] if no_cache else []
    # One Dockerfile, two targets: the caster image always, frame-sim only when wanted.
    compose("build", *extra, profile_sims=with_sims)


def regenerate_sims_yml():
    log("regenerating docker-compose.sims.yml from the manuals")
    text = compose("run", "--rm", "--no-deps", "-T", CASTER, "compose", capture=True)
    if not text or "services:" not in text:
        die("trunk-caster compose printed nothing usable; docker-compose.sims.yml left unchanged")
    old = ""
    if os.path.isfile(SIMS_YML):
        with open(SIMS_YML, encoding="utf-8") as f:
            old = f.read()
    if old == text:
        log("docker-compose.sims.yml unchanged")
        return
    with open(SIMS_YML, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    n = sum(1 for line in text.splitlines() if line.startswith("  sim-"))
    log("docker-compose.sims.yml written: %d simulators" % n)


def up(with_sims, running):
    if not with_sims:
        stale = [s for s in running if s.startswith("sim-")]
        if stale:
            log("stopping %d simulators" % len(stale))
            compose("rm", "--stop", "--force", *stale, profile_sims=True)
    compose("up", "-d", "--remove-orphans", profile_sims=with_sims)


def wait_healthy(url, timeout):
    status_url = url.rstrip("/") + "/api/status"
    log("waiting for %s" % status_url)
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(status_url, timeout=3) as r:
                body = json.loads(r.read().decode("utf-8", "replace"))
            return body
        except (urllib.error.URLError, OSError, ValueError) as e:
            last = e
            time.sleep(1.5)
    die("the caster did not answer within %ds (%s); try: docker compose logs trunk-caster" % (timeout, last))


def report(status, with_sims):
    frames = status.get("frames")
    trunks = status.get("trunks")
    conns = status.get("connections")
    log("caster healthy: %s frames, %s trunks, %s live connections" % (frames, trunks, conns))
    running = running_services()
    sims_up = [s for s in running if s.startswith("sim-")]
    if with_sims:
        wanted = sim_services()
        missing = sorted(set(wanted) - set(sims_up))
        log("%d of %d simulators running" % (len(sims_up), len(wanted)))
        if missing:
            log("not running: " + ", ".join(missing))
    elif sims_up:
        log("%d simulators still running" % len(sims_up))


def prune():
    out = run(["docker", "image", "prune", "--force"], capture=True) or ""
    tail = [l for l in out.splitlines() if l.strip()]
    log(tail[-1] if tail else "nothing to prune")


# ---------------------------------------------------------------------------
# publishing the public snapshot
# ---------------------------------------------------------------------------

# Static page the runtime rewrites every few seconds -> published file.
PAGE_SOURCES = {
    "TRUNK-GLOBAL/index.html": "index.html",
    "TRUNK-GLOBAL/continents.html": "continents.html",
    "TRUNK-GLOBAL/about.html": "about.html",
    "TRUNK-GLOBAL/panels.html": "panels.html",
    "TRUNK-USAGE/overlord.html": "overlord.html",
    "TRUNK-USAGE/index.html": "usage.html",
    "TRUNK-USAGE/space.html": "space.html",
    "TRUNK-SIMULATOR/racks.html": "racks.html",
    "TRUNK-SIMULATOR/index.html": "simulator.html",
    "TRUNK-RELAY/index.html": "relay.html",
    "TRUNK-USERS/index.html": "users.html",
    "TRUNK-CROSS POINTS/index.html": "crosspoints.html",
}

# Runtime paths -> published files, for the links inside the pages.
PAGE_LINKS = {
    "/": "index.html", "/globe": "index.html", "/continents": "continents.html", "/discovery": "continents.html",
    "/overlord": "overlord.html", "/panels": "panels.html", "/lights": "panels.html", "/usage": "usage.html",
    "/space": "space.html", "/racks": "racks.html", "/relay": "relay.html", "/users": "users.html",
    "/crosspoints": "crosspoints.html", "/simulator": "simulator.html", "/home": "about.html", "/about": "about.html",
}


def sh(*cmd, check=True, cwd=None):
    """Run a command for publishing, capturing its output. Dies with the output on failure."""
    try:
        r = subprocess.run(cmd, cwd=cwd or ROOT, text=True, capture_output=True,
                           encoding="utf-8", errors="replace")
    except FileNotFoundError:
        die("%s is not on PATH" % cmd[0])
    if check and r.returncode != 0:
        die("$ %s\n%s%s" % (" ".join(cmd), r.stdout, r.stderr))
    return r


def free_memory_mb():
    """Physical memory free right now, MB (None when it cannot be read)."""
    try:
        if os.name == "nt":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("len", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                            ("avail", ctypes.c_ulonglong), ("tp", ctypes.c_ulonglong), ("ap", ctypes.c_ulonglong),
                            ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ae", ctypes.c_ulonglong)]
            m = MS()
            m.len = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.avail // (1024 * 1024)
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None


# Memory one simulation slice may reach (it holds a day of frames), and what
# to leave free for everything else. Sixteen slices on a machine with Docker
# running ran it out of memory.
SLICE_MB = 500
SPARE_MB = 1024


def simulate_year(days, workers=None):
    """Run `trunk-caster simulate` in parallel slices into .replay/. Returns True when complete."""
    crate = os.path.join(ROOT, "RUST-RUNTIME")
    log("building the release binary for the simulation")
    if subprocess.run(["cargo", "build", "--release", "--quiet"], cwd=crate).returncode != 0:
        die("cargo build failed; no replay")
    exe = os.path.join(crate, "target", "release", "trunk-caster" + (".exe" if os.name == "nt" else ""))
    if REPLAY.exists():
        shutil.rmtree(REPLAY)
    REPLAY.mkdir()
    if not workers:
        free = free_memory_mb()
        by_memory = (free - SPARE_MB) // SLICE_MB if free else 4
        workers = max(1, min(days, os.cpu_count() or 2, by_memory))
        log("%s MB free: %d slices at a time" % (free if free is not None else "?", workers))
    per = -(-days // workers)
    procs = []
    for first in range(0, days, per):
        n = min(per, days - first)
        cmd = [exe, "simulate", "--root", ROOT, "--first-day", str(first), "--days", str(n), "--tick-ms", "1000",
               "--fader", PREVIEW_FADER, "--out", str(REPLAY)]
        # No log files: progress is counted from the day files written.
        procs.append((first, cmd, subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)))
    log("simulating %d days in %d slices of up to %d days" % (days, len(procs), per))
    while any(p.poll() is None for *_, p in procs):
        time.sleep(30)
        done = len(list(REPLAY.glob("day-*.json")))
        log("  %d/%d days simulated" % (done, days))
    ok = True
    for first, cmd, p in procs:
        if p.returncode != 0:
            ok = False
            log("  slice from day %d failed (exit %s); run it alone to see why: %s" % (first, p.returncode, " ".join('"%s"' % c if " " in c else c for c in cmd)))
    try:
        index = json.loads((REPLAY / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {}
    if index.get("days") != days:
        log("replay incomplete: index lists %s of %d days" % (index.get("days"), days))
        ok = False
    else:
        # The site serves the days gzipped; the pages unpack them.
        for f in sorted(REPLAY.glob("day-*.json")):
            with open(f, "rb") as src, gzip.open(str(f) + ".gz", "wb", compresslevel=9) as dst:
                shutil.copyfileobj(src, dst)
            f.unlink()
        size = sum(f.stat().st_size for f in REPLAY.glob("day-*.json.gz"))
        log("replay ready: %d days, %.0f MB gzipped" % (days, size / 1e6))
    return ok


def rewrite_page(html, endpoint):
    # Absolute links to the running caster become links between the pages.
    for path, target in sorted(PAGE_LINKS.items(), key=lambda kv: -len(kv[0])):
        html = html.replace('href="%s%s"' % (endpoint, path), 'href="%s"' % target)
        html = html.replace('href="%s"' % path, 'href="%s"' % target)
    html = html.replace('href="%s"' % endpoint, 'href="index.html"')
    # A simulated year to play back in place of the live stream.
    if (REPLAY / "index.json").is_file():
        html = html.replace("<head>", "<head><script>window.TC_REPLAY='replay/';</script>", 1)
    # Make it plain that this is a snapshot.
    html = html.replace("Static snapshot. Open",
                        "Public snapshot of the Trunk-Caster pages, refreshed when published. "
                        "Live controls need the running caster: open")
    return html


def collect_pages():
    """Read the static pages the caster wrote and rewrite their links. {published name: html}"""
    endpoint = DEFAULT_URL
    try:
        sample = (pathlib.Path(ROOT) / "TRUNK-GLOBAL/index.html").read_text(encoding="utf-8", errors="replace")
        m = re.search(r'href="(http://[^/"]+)/overlord"', sample)
        if m:
            endpoint = m.group(1)
    except FileNotFoundError:
        pass
    files = {}
    for src, dst in PAGE_SOURCES.items():
        p = pathlib.Path(ROOT) / src
        if p.is_file():
            files[dst] = rewrite_page(p.read_text(encoding="utf-8", errors="replace"), endpoint)
        else:
            log("  (missing) " + src)
    if not files:
        die("nothing to publish: run the caster first so the static pages exist")
    return files


def publish_pages(repo, dry_run=False):
    """Push the static pages to the public GitHub Pages repository. Returns the public link."""
    if shutil.which("gh") is None:
        die("publishing needs the GitHub CLI (gh), signed in")
    login = sh("gh", "api", "user", "--jq", ".login").stdout.strip()
    full = "%s/%s" % (login, repo)
    url = "https://%s.github.io/%s/" % (login.lower(), repo)

    files = collect_pages()
    log("%d pages to publish to %s -> %s" % (len(files), full, url))
    if dry_run:
        for dst in files:
            log("   " + dst)
        return url

    if sh("gh", "repo", "view", full, "--json", "name", check=False).returncode != 0:
        sh("gh", "repo", "create", full, "--public", "--description",
           "Public snapshot of the Trunk-Caster pages (the globe, the overlord, usage, racks, relay). "
           "The runtime lives in a private repository.")
        log("created " + full)

    if not (PAGES / ".git").is_dir():
        PAGES.mkdir(exist_ok=True)
        sh("git", "init", "-b", "main", cwd=str(PAGES))
        sh("git", "remote", "add", "origin", "https://github.com/%s.git" % full, cwd=str(PAGES))
        sh("git", "pull", "origin", "main", check=False, cwd=str(PAGES))

    for name in list(PAGES.iterdir()):
        if name.name == ".git":
            continue
        if name.is_dir():
            shutil.rmtree(name)
        else:
            name.unlink()
    for dst, html in files.items():
        (PAGES / dst).write_text(html, encoding="utf-8")
    if (REPLAY / "index.json").is_file():
        shutil.copytree(REPLAY, PAGES / "replay")
        log("replay: %d days copied" % len(list((PAGES / "replay").glob("day-*.json.gz"))))
    (PAGES / ".nojekyll").write_text("", encoding="utf-8")
    stamp = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    (PAGES / "README.md").write_text(
        "# Trunk-Caster pages\n\nPublic snapshot of the Trunk-Caster interface, published %s.\n"
        "The runtime and its source live in a private repository; these pages are static copies "
        "refreshed when published.\n\n[Open the globe](%s)\n" % (stamp, url),
        encoding="utf-8")

    sh("git", "add", "-A", cwd=str(PAGES))
    if sh("git", "status", "--porcelain", cwd=str(PAGES)).stdout.strip():
        sh("git", "-c", "user.name=" + login, "-c", "user.email=" + login + "@users.noreply.github.com",
           "commit", "-q", "-m", "Publish pages " + time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
           cwd=str(PAGES))
        sh("git", "push", "-u", "origin", "main", cwd=str(PAGES))
        log("pages pushed")
    else:
        log("pages unchanged; nothing to push")

    # Turn Pages on (idempotent).
    r = sh("gh", "api", "-X", "POST", "repos/%s/pages" % full,
           "-f", "source[branch]=main", "-f", "source[path]=/", check=False)
    if r.returncode == 0:
        log("GitHub Pages enabled")
    else:
        status = sh("gh", "api", "repos/%s/pages" % full, "--jq", ".status", check=False)
        log("GitHub Pages: " + ((status.stdout.strip() or "already configured")
                                if status.returncode == 0 else r.stderr.strip()[:200]))
    log("public link: " + url)
    return url


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--sims", action="store_true", help="rebuild and start one simulator per protocol")
    g.add_argument("--no-sims", action="store_true", help="caster only; stop any simulators")
    ap.add_argument("--sims-yml", action="store_true", help="regenerate docker-compose.sims.yml from the manuals")
    ap.add_argument("--no-check", action="store_true", help="skip the local cargo check")
    ap.add_argument("--no-cache", action="store_true", help="build the images without the Docker cache")
    ap.add_argument("--prune", action="store_true", help="remove dangling images afterwards")
    ap.add_argument("--open", action="store_true", help="open the pages in the browser once healthy")
    ap.add_argument("--logs", action="store_true", help="follow the caster log afterwards")
    ap.add_argument("--down", action="store_true", help="stop and remove all containers instead of rebuilding")
    ap.add_argument("--publish", action="store_true", help="push the static pages to the public site once healthy")
    ap.add_argument("--publish-only", action="store_true", help="publish the pages already on disk; no rebuild")
    ap.add_argument("--pages-repo", help="public pages repository to publish to (required with --publish / --publish-only)")
    ap.add_argument("--dry-run", action="store_true", help="with --publish: list the pages instead of pushing")
    ap.add_argument("--replay", type=int, nargs="?", const=365, metavar="DAYS",
                    help="simulate DAYS (default 365) for the public site's replay before publishing")
    ap.add_argument("--replay-workers", type=int, metavar="N",
                    help="simulation slices at a time (default: what free memory allows, %d MB each)" % 500)
    ap.add_argument("--url", default=os.environ.get("TRUNK_PUBLIC_URL", DEFAULT_URL),
                    help="where the caster answers (default %(default)s)")
    ap.add_argument("--timeout", type=int, default=90, help="seconds to wait for the caster (default 90)")
    args = ap.parse_args()

    if (args.publish or args.publish_only) and not args.pages_repo:
        die("--publish needs --pages-repo: there is no default public site any more")

    if args.replay and not simulate_year(args.replay, args.replay_workers):
        die("the replay simulation did not finish; nothing published")

    if args.publish_only:
        publish_pages(args.pages_repo, args.dry_run)
        return

    preflight()

    if args.down:
        compose("down", "--remove-orphans", profile_sims=True)
        log("everything stopped")
        return

    if not args.no_check:
        cargo_check()

    running = running_services()
    with_sims = decide_sims(args, running)

    build(with_sims, args.no_cache)
    if args.sims_yml:
        regenerate_sims_yml()
    up(with_sims, running)

    status = wait_healthy(args.url, args.timeout)
    report(status, with_sims)
    if args.prune:
        prune()
    log("pages at %s/" % args.url.rstrip("/"))
    if args.publish:
        # Give the caster a moment to write a fresh set of pages before copying them.
        time.sleep(3)
        publish_pages(args.pages_repo, args.dry_run)
    if args.open:
        webbrowser.open(args.url.rstrip("/") + "/")
    if args.logs:
        try:
            subprocess.run(["docker", "compose", "logs", "-f", "--tail", "40", CASTER], cwd=ROOT)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.stdout.write("\n")
        die("interrupted", 130)
