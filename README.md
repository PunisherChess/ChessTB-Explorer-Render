# ChessTB Explorer ♟️

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/PunisherChess/ChessTB-Explorer-Render)

A single-page web application for exploring **ChessTB** chess endgame
tablebases. Paste or build any position on an interactive board and
instantly see every legal move ranked by **Distance to Zeroing (DTZ)**,
**Distance to Conversion (DTC)**, **Distance to Mate (DTM)**, and **DTM
under the 50-move rule (DTM50)** — straight from the tablebase, with no
chess engine involved.

The backend is a small Flask application that probes the tablebase through
a modified fork of [`python-chess`](https://github.com/noobpwnftw/python-chess/tree/add-chesstb-tablebases)
(the `chess.chesstb` module — see [Installation](#installation)). The frontend is
dependency-light vanilla JavaScript built around
[Chessground](https://github.com/lichess-org/chessground) (lichess.org's
board component) and [chess.js](https://github.com/jhlywa/chess.js).

> This tool only *displays* tablebase results — it does not generate,
> verify, or ship any tablebase data itself. See
> [Getting the tablebase files](#getting-the-tablebase-files) below.

> The probe endpoints are unauthenticated by design — evaluating a
> position is this app's public functionality. The `/admin` cache
> dashboard is gated behind `ADMIN_TOKEN`, a secret you configure
> yourself (see [Security notes](#security-notes)).

---

## Features

- **Interactive board** — drag-and-drop moves, click-to-place pieces from
  the spare-piece trays, pawn promotion dialog, board flip (orientation
  persisted locally across visits), undo/redo.
- **Lock** — a padlock button beside the FEN box that restricts board
  interaction to legal moves only: dragging, click-to-move, and the
  spare-piece trays are limited to the side to move's legal destinations,
  and off-board drops are disabled. Unlocked by default; a manual toggle
  is remembered locally across visits. Auto-play also engages Lock for
  the duration of a run (unless already locked by hand), and disables the
  padlock button until the run stops.
- **Four ranked move tables side by side** — DTZ, DTC, DTM, and DTM50
  columns, each independently sorted best-move-first, with:
  - score text colour-coded by outcome (win / cursed win / draw /
    blessed loss / loss)
  - a **warning dot** on any move flagged cursed win or blessed loss,
    with a hover tooltip explaining the 50-move-rule nuance
  - an **info dot** on a draw by insufficient material, keeping the score
    text itself reading as a plain "Draw"
  - an outcome summary (wins / draws / losses / unknown) for the position
  - an optional pinned **Root Row** above rank 1, showing the current
    position's own score for each metric as a reference point — toggled
    from the settings panel (**Show Root Row**, off by default) and
    persisted locally
- **Best-move arrows** — the top DTZ, DTC, DTM, and DTM50 moves are drawn
  as colour-coded arrows directly on the board.
- **Auto-play** — automatically plays the best move for any of the four
  metrics on a timer, so you can watch a line play out. The per-move delay
  is set from the settings panel (**Autoplay Delay**, 0s–2.5s in 50ms
  steps, 1.25s by default) and acts as a floor — a move that's still
  waiting on its tablebase probe takes as long as the probe does,
  regardless of the delay setting. A metric's button is disabled when its
  table isn't present for the current material, or when the position is
  already a draw.
- **PGN import/export** — paste a PGN to load a game and click through its
  moves, or copy the current line as PGN.
- **CSV export** of the current move table, including the Root Row line
  ahead of rank 1 when that setting is on.
- **Move-list / PGN panel** with full undo/redo and click-to-jump — jumping
  to an earlier point in the line re-uses the cached probe instead of
  re-querying the tablebase.
- **Shareable positions** — the FEN is written to the URL hash on every
  move, so a link to the page reproduces the exact position.
- **Session persistence** — the in-progress game (not just the position)
  survives a trip to the admin dashboard and back.
- **Board and piece set** — Libre Brown board, CBurnett piece set.
- **Streaming probes** — `/probe/stream` reports progress via
  Server-Sent Events while child positions are being probed, so the UI
  shows a live progress bar instead of a blank pause on slower lookups.
- **Hover pre-fetch** — hovering a move in the table warms the cache for
  the resulting position before you click it.
- **Admin cache dashboard** (`/admin`, behind `ADMIN_TOKEN`) — live
  hit-rate stats for both LRU caches, thread-pool configuration, and a
  one-click cache-clear button.
- **Machine-readable API** — the full HTTP API is described by an OpenAPI
  3.0 document served at `/openapi.yaml`.
- **Keyboard shortcuts** — `Enter` Apply, `F` Flip, `C` Clear, `←`/`→`
  Back/Forward.

---

## Architecture at a glance

```
Browser (vanilla JS, ES modules)
  ├─ board.js      — chessground wrapper: drag/drop, history, arrows
  ├─ tablebase.js   — talks to /probe/stream, renders the move tables
  ├─ theme.js       — board/piece-set theming
  ├─ ui.js          — wires everything together: FEN box, PGN, auto-play,
  │                    settings panel, keyboard shortcuts
  └─ app.js         — bootstrap
        │  HTTP (JSON) / SSE (text/event-stream)
        ▼
Flask app (app.py)
  ├─ /probe, /probe/stream   — evaluate a FEN, rank every legal move
  ├─ /admin, /admin/cache/*  — cache dashboard + stats API
  └─ /openapi.yaml           — API specification
        │
        ▼
tablebase_router.py — routes each probe by piece count and castling
rights across up to three independently-opened sources: TABLEBASE_PATH,
TABLEBASE_PATH_7_8, TABLEBASE_PATH_CASTLING
        │
        ▼
chesstb.open_tablebase(...) per source   (noobpwnftw's modified python-chess fork)
        │
        ▼
ChessTB tablebase files — local disk, or a remote http(s) URL (probed
in place over byte ranges by default, or downloaded and cached to local
disk per material — see remote/remote_direct.py, remote/remote_fallback.py,
and "Getting the tablebase files" below)
```

This covers the main explorer page's (`index.html`) module graph — see
[Project structure](#project-structure) below for the complete file set,
including `admin.js` (the `/admin` dashboard's client script) and
`utils.js` (a small shared helper).

Each module carries a file-level docstring/header comment describing its
own responsibilities, and the move-ranking algorithm itself — including
its treatment of the 50-move rule — is documented inline in `app.py`
above `evaluate_all_moves()` and the `_effective_move_wdl`/
`_effective_distance`/`_order_rank` helpers it calls.

---

## Prerequisites

- **Python 3.10+**
- **Git**, on your `PATH` — `pip install -r requirements.txt` fetches the
  `python-chess` fork directly from GitHub (`chess @ git+https://...`),
  which requires `git` to be installed even though the package itself is
  Python.
- **A ChessTB tablebase directory or URL** — either a local directory on
  disk, or an `http(s)://` base URL serving the same layout remotely with
  no local download (see [Getting the tablebase files](#getting-the-tablebase-files)).
  The app starts without one, but every probe will fail until
  `TABLEBASE_PATH` points at one of the two. `TABLEBASE_PATH_7_8` and
  `TABLEBASE_PATH_CASTLING` are optional extensions of the same setting —
  see [Configuration reference](#configuration-reference).
- A modern browser (the frontend uses native ES modules, `fetch`, and
  `ReadableStream`).

---

## Installation

1. **Create and activate a virtual environment:**

   ```bash
   python -m venv .venv
   source .venv/bin/activate      # Windows: .venv\Scripts\activate
   ```

2. **Install dependencies:**

   ```bash
   pip install -r requirements.txt
   ```

   This pulls in the **modified `python-chess` fork** (not the plain
   PyPI `chess` package; see the comments in `requirements.txt` for why
   that distinction matters).

3. **Get the tablebase files** — see the next section. If you're using the
   remote (no-download) option, there's nothing to fetch here at all —
   skip straight to step 4 and point `TABLEBASE_PATH` at the URL.

4. **Configure `config.py`** — open it and set `TABLEBASE_PATH` to the
   directory (or URL) from step 3:

   ```python
   TABLEBASE_PATH = "/data/chesstb"
   ```

   or, for the remote option:

   ```python
   TABLEBASE_PATH = "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve"
   ```

   This alone covers every piece count. See
   [Getting the tablebase files](#getting-the-tablebase-files) for
   `TABLEBASE_PATH_7_8` and `TABLEBASE_PATH_CASTLING`, which add
   castling-rights coverage and faster probing on 3-6 piece positions.

   Every other setting in `config.py` has a sensible default and a
   comment explaining what it does — see
   [Configuration reference](#configuration-reference) for the complete
   list. Just open the file and edit the values directly. If you want the
   header's GitHub button to link somewhere, set `GITHUB_URL` there too.

5. **Run the app:**

   ```bash
   python app.py
   ```

   By default (`DEBUG = False` in `config.py`) this serves the app via
   **waitress**, a production-grade pure-Python WSGI server — see
   [Running in production](#running-in-production) below. Set
   `DEBUG = True` in `config.py` instead if you want Flask's own dev
   server (auto-reload, interactive debugger) for local development.

6. Open **http://127.0.0.1:7860** in your browser.

---

## Getting the tablebase files

Where the tablebase *data* lives is a separate question from where this
*app* runs — Option A below points `TABLEBASE_PATH` at a plain
`http(s)://` URL, so it works identically regardless of which platform
serves the app itself (Render, Hugging Face Spaces, your own machine,
etc.); `remote/remote_source.py` speaks plain HTTP byte-range requests,
nothing more, and has no dependency on any one host. See
[Deploying to Render](#deploying-to-render) for the app side of that
distinction.

ChessTB tablebase files are available two ways:

### Option A — Remote, downloaded on demand (recommended)

The full ChessTB set is published as a Hugging Face storage bucket,
browsable at:

```
https://huggingface.co/buckets/noobpwnftw/chesstb
```

Its root holds `wdl/`, `dtz/`, `dtc/`, `dtm/`, `dtm50/`, `full/`, and
`castling/`. Every one of those is in the shrunk shipping format except
`full/`. `wdl/` and `dtz/` cover 3-8 piece material; `dtc/`, `dtm/`,
`dtm50/`, and `castling/` cover 3-6 piece material only. `full/` mirrors
the same five metrics plus `castling/` again, in the unshrunk format the
generator produces directly — 3-6 piece material only, but faster to probe
than the shrunk set.

Raw file bytes for a bucket path are served from the matching
`/resolve/<path>` URL. The recommended setup points each of the three
`TABLEBASE_PATH*` settings at whichever part of that layout answers it
fastest — `full/` for 3-6 piece and castling-rights material, the bucket
root for the 7-8 piece material `full/` doesn't have:

```python
TABLEBASE_PATH          = "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve/full"
TABLEBASE_PATH_7_8      = "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve"
TABLEBASE_PATH_CASTLING = "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve/full/castling"
```

`TABLEBASE_PATH_7_8` and `TABLEBASE_PATH_CASTLING` are optional: each
falls back to `TABLEBASE_PATH` when left unset (see
[Configuration reference](#configuration-reference)), so pointing
`TABLEBASE_PATH` alone at the bucket root is a complete single-URL setup
covering every piece count, just without `full/`'s speed advantage on
3-6 piece material and without castling-rights coverage (castling tables
live only under `castling/`, not alongside the plain material files).

However many of the three are set, the app probes tables over HTTP.
`REMOTE_MODE` picks how:

- **`"direct"` (default)** — `remote/remote_direct.py` probes the remote
  tables **in place**, fetching only the `REMOTE_PAGE_SIZE_BYTES`-sized
  byte ranges each probe actually reads and keeping them in an in-memory
  LRU bounded by `REMOTE_PAGE_CACHE_BYTES`. Nothing is written to disk.
  This uses `chess.chesstb`'s table-source seam
  (`Tablebase.WDL_FILE` / `_TableFile._open_source`); if your installed
  fork predates it, the app logs that and falls back to `"download"`.
- **`"download"`** — `remote/remote_fallback.py` fetches each table
  **in full** the first time a probe touches its material and caches it
  in a temporary local directory (bounded by
  `REMOTE_PAGE_CACHE_BYTES` as an on-disk budget, evicting
  least-recently-used files, removed entirely when the app stops). Every
  probe after the first is then a local mmap read.

`"direct"` is the better default for browsing across many materials, which
is what this app does. Prefer `"download"` when you hammer a handful of
materials in one long session, or on a high-latency link: a ChessTB probe
is not a narrow read — a dropped-frame table is reconstructed by walking
its children, and pawn positions reach promotion sub-tables — so one cold
probe can open several materials and issue several fetches against each.
That is also why `REMOTE_PAGE_SIZE_BYTES` should stay large. See each
module's docstring for the full design.

This is a good fit for a machine that doesn't have (or doesn't want to
dedicate) a couple of terabytes of local disk for the full tablebase set —
at the cost of probe latency on first touch of any given material
(depending on your connection to the CDN), some temporary local disk
usage for whichever material you've actually probed this session, and of
course requiring a connection at all. `git`/`chess.chesstb` install
requirements are unaffected; remote mode only additionally needs the
`requests` package (see `requirements.txt`).

### Option B — Local directory, over FTP

The same tables are also distributed over FTP for a fully local, offline
setup:

```
ftp://chessdb:chessdb@ftp.chessdb.cn/pub/chesstb/
```

Any FTP client works, for example:

```bash
# lftp
lftp -e "mirror --parallel=4 /pub/chesstb/ /data/chesstb; quit" \
     ftp://chessdb:chessdb@ftp.chessdb.cn

# curl (single file)
curl "ftp://chessdb:chessdb@ftp.chessdb.cn/pub/chesstb/<path-to-file>" -o <local-file>
```

Tablebase sets are large and grow quickly with piece count — check
available disk space before mirroring the full archive, and consider
mirroring only the subsets (piece counts) you need. Point
`TABLEBASE_PATH` at whichever directory you end up with.

---

However you set it, if `TABLEBASE_PATH` is unset, missing/unreachable, or
points at a location with no usable tables, the app still starts (with a
warning in the logs) — every `/probe` request will then return an error,
and `/health` reports `"degraded"`. Leaving `TABLEBASE_PATH_7_8` or
`TABLEBASE_PATH_CASTLING` unset isn't an error condition — it just routes
the material each would have covered through `TABLEBASE_PATH` instead, as
described above.

---

## Configuration reference

All configuration lives in **`config.py`**, as plain Python values. Open
it and edit the settings directly — each one has a comment above it
explaining what it does. The table below is the complete reference.

| Setting                     | Default          | Description |
|-----------------------------|-------------------|-------------|
| `TABLEBASE_PATH`            | `""` (also readable from a `TABLEBASE_PATH` env var) | Directory containing your ChessTB tablebase files, **or** an `http(s)://` base URL serving the same layout remotely (e.g. a Hugging Face storage bucket — see [Getting the tablebase files](#getting-the-tablebase-files)). Required for probing to work. On Render, set this from the service's Environment tab (or `render.yaml`'s prompt) instead of editing the file. |
| `TABLEBASE_PATH_7_8`        | `""` (also readable from a `TABLEBASE_PATH_7_8` env var) | Same accepted forms as `TABLEBASE_PATH`, covering 7-8 piece material specifically. Left empty, 7-8 piece positions are routed through `TABLEBASE_PATH` instead. |
| `TABLEBASE_PATH_CASTLING`   | `""` (also readable from a `TABLEBASE_PATH_CASTLING` env var) | Same accepted forms as `TABLEBASE_PATH`, covering castling-rights positions specifically, independent of piece count. Left empty, such a position is routed through `TABLEBASE_PATH`/`TABLEBASE_PATH_7_8` by piece count instead, which only resolves it if that tablebase happens to carry castling-rights tables too. |
| `DEBUG`                     | `False`           | `True` runs `app.py` via Flask's own dev server (auto-reload, detailed tracebacks) instead of waitress. Leave `False` — which serves via waitress — for anything reachable from another machine. See [Running in production](#running-in-production). |
| `HOST`                      | `"0.0.0.0"`       | Interface the server (waitress, or the dev server if `DEBUG = True`) binds to. |
| `PORT`                      | `7860` (also readable from a `PORT` env var) | Port the server listens on. Render injects its own `PORT` at deploy time and this picks it up automatically — nothing to set for a Render deployment. |
| `WAITRESS_THREADS`          | `4`               | Worker threads in waitress's request-handling pool. Only relevant when `DEBUG = False`. Needs to be more than 1 so a long-lived `/probe/stream` connection can't block other requests. |
| `PROBE_THREADS`             | `2`               | Worker threads in the probe thread pool used to evaluate a position's legal moves in parallel. Set an explicit integer to match the host's CPU count, or `None` to scale automatically (`min(16, cpu*2)`). |
| `PROBE_PARALLEL_THRESHOLD`  | `4`               | Minimum number of child positions before probing switches from sequential to the thread pool. |
| `PROBE_TIMEOUT_SECS`        | `30`              | Wall-clock timeout for a batch of parallel child probes. Also bounds how long a request waits on another thread's in-flight probe of the same FEN before giving up with a retryable `probe_timeout` error. |
| `EVALUATE_CACHE_SIZE`       | `4096`            | Max entries in the root-FEN result cache (full JSON responses). |
| `PROBE_CACHE_SIZE`          | `16384`           | Max entries in the child-position probe cache (raw WDL/DTZ/DTC/DTM/DTM50 tuples). |
| `BLOCK_CACHE_BYTES`         | `67108864` (64 MiB) | Size, in bytes, of `chesstb`'s own internal cache of decoded/decompressed tablebase blocks (shared across the WDL/DTZ/DTC/DTM/DTM50 tables). Raising this trades RAM for fewer repeated disk reads/HTTP fetches + decompressions across a session — most worthwhile when `PROBE_PARALLEL_THRESHOLD` is set high enough that probing runs mostly serially. |
| `REMOTE_MODE`               | `"direct"`        | **Remote tablebase entries only.** `"direct"` probes the remote tables in place over byte ranges (nothing written to disk); `"download"` fetches each table in full on first touch and caches it on local disk. Falls back to `"download"` if the installed `chess.chesstb` has no table-source seam. See [Getting the tablebase files](#getting-the-tablebase-files). |
| `REMOTE_PAGE_CACHE_BYTES`   | `134217728` (128 MiB) | **Remote tablebase entries only.** Soft budget, in bytes, shared across every remote table opened this session: the in-memory page cache in `"direct"` mode, the on-disk cache of whole downloaded files in `"download"` mode. See [Getting the tablebase files](#getting-the-tablebase-files). |
| `REMOTE_PAGE_SIZE_BYTES`    | `262144` (256 KiB) | **Remote tablebase entries only.** Size, in bytes, of one page. In `"direct"` mode this is the granularity of every fetch, so it trades over-fetching against round trips per probe; in `"download"` mode it is only the chunk size used while streaming a full file down. |
| `REMOTE_TIMEOUT_SECS`       | `20`              | **Remote tablebase entries only.** Per-HTTP-request timeout for existence/size checks and the download itself. |
| `REMOTE_MAX_RETRIES`        | `3`               | **Remote tablebase entries only.** Attempts for a single remote request before it's treated as failed. |
| `PROBE_RATE_LIMIT`          | `"60 per minute"` | Per-client-IP request limit on `/probe` and `/probe/stream`, using [flask-limiter](https://flask-limiter.readthedocs.io/)'s string syntax. Left empty, rate limiting is disabled entirely. See [Security notes](#security-notes). |
| `ADMIN_LOGIN_RATE_LIMIT`    | `"5 per minute"`  | Per-client-IP request limit on `/admin/login`, same string syntax as `PROBE_RATE_LIMIT`, applied independently of it. Covers both failed and successful login attempts. Left empty, login attempts are not rate limited. See [Security notes](#security-notes). |
| `TRUSTED_PROXY_COUNT`       | `1` (also readable from a `TRUSTED_PROXY_COUNT` env var) | Number of trusted reverse-proxy hops in front of this app. In production this configures [waitress's own `trusted_proxy_count`](https://docs.pylonsproject.org/projects/waitress/en/stable/proxy-headers.html) (waitress parses `X-Forwarded-For`/`X-Forwarded-Proto` and corrects `REMOTE_ADDR`/`wsgi.url_scheme` itself, ahead of Flask); [Werkzeug's `ProxyFix`](https://werkzeug.palletsprojects.com/en/latest/middleware/proxy_fix/) makes the same correction for the `DEBUG = True` dev-server path, which doesn't run under waitress. Both rate limiters key on the corrected address, and `request.scheme`/`request.is_secure` read the corrected scheme. `1` matches this project's own `render.yaml` topology (Render's edge/load-balancer, once). Adjust to match your own reverse proxy chain, or set to `0` for a deployment with no reverse proxy in front of it at all. See [Security notes](#security-notes). |
| `ADMIN_TOKEN`                | `""` (from `ADMIN_TOKEN` env var) | Shared secret required to reach `/admin` and `/admin/cache/*`. Read from the environment rather than hardcoded, so it can be set as a platform secret. Left unset, admin routes respond `503` rather than running unprotected. See [Security notes](#security-notes). |
| `FLASK_SECRET_KEY`           | `""` (from `FLASK_SECRET_KEY` env var) | Key used to sign the admin session cookie. Read from the environment for the same reason as `ADMIN_TOKEN`. Left unset, a random key is generated at process startup instead, which just means every restart requires logging back in. |
| `SESSION_COOKIE_SECURE`      | `False` (also readable from a `SESSION_COOKIE_SECURE` env var) | Whether the admin session cookie set by `/admin/login` requires HTTPS. Independent of `DEBUG` — the default matches this project's documented plain-HTTP local deployment; set the env var to `true` for any deployment the browser reaches over HTTPS (including behind a TLS-terminating reverse proxy such as Render's, which this project's own `render.yaml` already does). See [Security notes](#security-notes). |
| `GITHUB_URL`                 | `""` (also readable from a `GITHUB_URL` env var) | Repository URL for the GitHub button shown in the header of every page. Edited directly like any other non-secret value here, or set as an env var on a given deployment. Left empty, the button is omitted. |

Invalid values (wrong type, out of range) cause the app to log an error
and exit at startup rather than run with a silently-wrong configuration.

---

## Running in production

`python app.py` serves the app via **[waitress](https://docs.pylonsproject.org/projects/waitress/)**,
a production-grade, pure-Python WSGI server, whenever `DEBUG` in
`config.py` is `False` (the default) — no separate `gunicorn`/`waitress`
command or extra process is needed on top of the app itself. Setting
`DEBUG = True` in `config.py` switches `app.py` over to Flask's own dev
server instead (auto-reload + interactive debugger), which is meant for
local development only and should not be used for anything reachable
from another machine.

```bash
# Production (default): DEBUG = False in config.py — serves via waitress
python app.py

# Local development: set DEBUG = True in config.py first, then run the
# same command — Flask dev server, auto-reload + debugger
python app.py
```

- `HOST` / `PORT` control the interface and port waitress binds to, same
  as for the dev server. `PORT` is also readable from a `PORT`
  environment variable (see [Configuration reference](#configuration-reference)),
  which is what lets the same image bind correctly on Render — or any
  other platform that assigns the port at deploy time — with no edits.
- `WAITRESS_THREADS` (default `4`) sizes waitress's own pool of
  request-handling threads. This needs to be more than 1 for the same
  reason the dev server needs `threaded=True`: `/probe/stream` holds a
  connection open via Server-Sent Events for the whole duration of a
  probe, and a single-threaded server would let that one connection block
  every other request — including the browser's own concurrent requests
  for CSS/JS/piece images on first page load. It's independent of
  `PROBE_THREADS`, which sizes the thread pool used internally to
  parallelise tablebase probing rather than to serve HTTP requests.
- `TRUSTED_PROXY_COUNT` (default `1`) configures waitress's own
  `trusted_proxy_count`, so `request.remote_addr` and `request.scheme`
  reflect the real client IP and scheme behind Render's edge/load-balancer
  rather than that proxy's own address/hop — see
  [Security notes](#security-notes).
- Waitress handles `/probe/stream`'s streamed response natively; no
  additional configuration is needed for SSE to work correctly.
- The probe endpoints are unauthenticated by design; only `/admin` and
  `/admin/cache/*` require a credential (see
  [Security notes](#security-notes)).

---

## Deploying to Render

This project deploys to [Render](https://render.com) as a single Docker
web service, built straight from this GitHub repository — no separate
mirroring step or GitHub Action required. Render watches the branch you
connect and rebuilds/redeploys automatically on every push, the same way
it would for any other Dockerfile-based repo.

There are two ways to set it up:

### Option 1 — Blueprint (`render.yaml`, recommended)

This repository ships a [`render.yaml`](render.yaml) at its root
describing the service (Docker runtime, health check, environment
variables). Render finds it automatically:

1. Push this repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click
   **New → Blueprint** and connect the repo.
3. Render reads `render.yaml` and shows you the one setting it needs
   before the first deploy can run: **`TABLEBASE_PATH`** — the
   `http(s)://` base URL of your remote tablebase (see
   [Getting the tablebase files](#getting-the-tablebase-files)).
   `ADMIN_TOKEN` and `FLASK_SECRET_KEY` are generated for you
   automatically; nothing to type for those.
4. Click **Apply** / **Create**. Render builds the image from this
   repo's `Dockerfile` and deploys it.

Every subsequent push to the connected branch redeploys automatically.
To change `TABLEBASE_PATH`, `ADMIN_TOKEN`, or any other setting later,
edit it from the service's **Environment** tab in the Render Dashboard —
see [Configuration reference](#configuration-reference) for which
settings are env-overridable this way versus which live only in
`config.py`.

### Option 2 — Manual Web Service (no `render.yaml`)

Works identically without the Blueprint file, if you'd rather configure
everything by hand:

1. Push this repository to GitHub.
2. In the Render Dashboard, click **New → Web Service** and connect the
   repo.
3. Set **Runtime** to **Docker** (Render should detect the `Dockerfile`
   at the repo root automatically).
4. Under **Environment**, add:
   - `TABLEBASE_PATH` — required; same as Option 1 above.
   - `TABLEBASE_PATH_7_8`, `TABLEBASE_PATH_CASTLING` — optional; add
     either to extend coverage to 7-8 piece material or castling-rights
     positions from a separate source. Leaving them unset routes that
     material through `TABLEBASE_PATH` instead (see
     [Configuration reference](#configuration-reference)).
   - `ADMIN_TOKEN` — optional but recommended; any secret string, or
     use Render's "Generate" button. Leaving it unset just means
     `/admin` responds `503` until you set it later.
   - `FLASK_SECRET_KEY` — optional; a random one is generated at
     process startup if you skip it, which just means admin sessions
     don't survive a restart.
   - `GITHUB_URL` — optional; your repo's URL, if you want the header's
     GitHub button to appear.
   - `SESSION_COOKIE_SECURE` — set to `true`. Render always terminates
     TLS in front of the app, so the browser reaches it over HTTPS;
     `config.py`'s own default targets this project's plain-HTTP local
     deployment instead, so it needs to be set explicitly here (Option 1
     above sets it automatically via `render.yaml`). Leaving it unset
     doesn't fail closed — it makes `/admin/login` appear to succeed
     while the browser silently drops the session cookie, so every
     following `/admin/*` request comes back `401` (see
     [Security notes](#security-notes)).
   - Leave `PORT` alone — Render sets it itself, and `config.py` already
     reads it (see [Configuration reference](#configuration-reference)).
5. Under **Health Check Path**, set `/health` (matches the route in
   `app.py`; Render won't mark a deploy healthy until this returns `200`,
   which itself only happens once `TABLEBASE_PATH` has opened
   successfully).
6. Click **Create Web Service**.

### Choosing a plan

Probing is CPU-bound (block decompression on every request), so a
dedicated vCPU — Render's **Starter** tier or above — gives noticeably
snappier results than the **Free** tier's shared/limited CPU. Free still
works for casual or low-traffic use; just expect the service to spin
down after inactivity (a slow first request after waking up) and slower
probes under load. Either way, `REMOTE_MODE = "direct"` (the default)
means no persistent disk is needed regardless of plan — see
`config.py`'s "Remote (URL) tablebase entries only" section and
[Getting the tablebase files](#getting-the-tablebase-files).

---

## Usage guide

- **Set a position** — type or paste a FEN into the FEN box and press
  `Enter` or **Apply**. The move rankings and best-move arrows update
  automatically. The castling-availability field accepts `-` or any
  combination of `K`, `Q`, `k`, `q` (each requiring a matching king and
  rook on their home squares); a position with a castling right is
  evaluated the same as any other, reported as not covered if the
  loaded tablebase set has no table for it (see
  `TABLEBASE_PATH_CASTLING` in
  [Configuration reference](#configuration-reference)).
- **Edit the board directly** — drag pieces around the board, drag a piece
  off the board to remove it, or click a spare piece in either tray and
  then click a square to place it (click again / press `Esc` to cancel).
  Board edits reset the current move line the same way **Clear** does.
- **Lock the board** — click the padlock button beside the FEN box to
  restrict drag-and-drop, click-to-move, and the spare-piece trays to
  legal moves for the side to move; the button turns gold while active.
  Click again to unlock. The choice is remembered locally across visits.
  Starting auto-play locks the board automatically for the run (unless
  already locked) and disables the padlock button until it stops.
- **Play moves** — click any move in one of the four ranked tables to
  play it, or drag a piece on the board through a legal move.
- **Navigate history** — **Back**/**Forward** buttons or `←`/`→`, or click
  any move in the PGN panel to jump straight to that point in the line.
- **Auto-play** — click the ▶ button above the DTZ, DTC, DTM, or DTM50
  columns
  to have the app play that metric's best move on a timer (delay set by
  **Autoplay Delay** in settings, 1.25s by default); click again (now
  showing ■) to stop. Any manual navigation stops auto-play.
- **Import/export a game** — **Import** in the PGN panel opens a dialog to
  paste PGN text and jump to any parsed move; **Copy** copies the current
  line as PGN with standard headers.
- **Export the move table** — the **CSV** button downloads the current
  DTZ/DTC/DTM/DTM50 rankings as a CSV file.
- **Share a position** — the URL updates live with `#fen=...`; sending
  that link reproduces the exact position.
- **Change settings** — the ⚙ button in the header opens a **Show Root
  Row** switch for the results table and an **Autoplay Delay** slider;
  your choices are remembered across visits.
- **Admin dashboard** — the ⊙ icon opens `/admin`, prompting for the
  `ADMIN_TOKEN` on first visit, then showing live hit-rate stats for both
  caches and the thread-pool configuration, auto-refreshing every 5
  seconds.

---

## API

The full HTTP API — `/probe`, `/probe/stream`, `/health`,
`/admin/cache/stats`, `/admin/cache/clear`, `/admin/login`,
`/admin/logout` — is documented as an OpenAPI 3.0 specification served
live by the running app at:

```
http://127.0.0.1:7860/openapi.yaml
```

`openapi.yaml` documents every endpoint's request/response shapes; the
ranking algorithm behind `moves_dtz` / `moves_dtc` / `moves_dtm` /
`moves_dtm50` is documented inline in `app.py`'s own module docstring and
its `evaluate_all_moves()` function. `/admin/cache/*` require an
`Authorization: Bearer <ADMIN_TOKEN>` header or an authenticated session
cookie from `/admin/login` — see [Security notes](#security-notes).

Quick example:

```bash
curl -X POST http://127.0.0.1:7860/probe \
     -H "Content-Type: application/json" \
     -d '{"fen": "4k3/8/8/8/8/8/8/4K2R w - - 0 1"}'
```

---

## Project structure

```
.
├── LICENSE                 # This project's own license (see file for scope — does not cover bundled third-party assets)
├── THIRD_PARTY_LICENSES.md # Licenses/attributions for bundled third-party code, fonts, and the piece set
├── Dockerfile               # Container build used for Render (and any other Docker host)
├── render.yaml              # Render Blueprint: service definition, health check, env vars
├── app.py                  # Flask backend: routes, probing, caching
├── config.py               # All configuration, as plain Python values — see "Configuration reference"
├── openapi.yaml            # OpenAPI 3.0 specification, served at /openapi.yaml
├── requirements.txt
├── README.md
├── tablebase_router.py     # Routes each probe by piece count and castling rights across TABLEBASE_PATH/TABLEBASE_PATH_7_8/TABLEBASE_PATH_CASTLING
├── remote/
│   ├── remote_source.py     # Generic HTTP byte-range client shared by both remote backends — see its own module docstring
│   ├── remote_direct.py     # REMOTE_MODE="direct": probe remote tables in place over byte ranges — see its own module docstring
│   └── remote_fallback.py   # REMOTE_MODE="download": whole-file download, cached to local disk on first touch — see its own module docstring
├── templates/
│   ├── index.html          # Main explorer UI
│   └── admin.html          # Cache dashboard
└── static/
    ├── css/
    │   ├── main.css              # All application styling
    │   └── pieces-cburnett.css   # Piece-set stylesheet swapped in by board.js's reconstruct()
    ├── js/
    │   ├── app.js           # Bootstrap
    │   ├── board.js         # Chessground wrapper (drag/drop, history, arrows)
    │   ├── tablebase.js      # /probe/stream client + results rendering
    │   ├── theme.js          # Board / piece-set theming
    │   ├── ui.js             # UI controller (FEN box, PGN, auto-play, settings)
    │   ├── admin.js          # Admin dashboard client
    │   └── utils.js          # Shared helpers (debounce)
    ├── pieces/cburnett/     # Piece-set SVGs
    └── vendor/               # Third-party libraries (Chessground, chess.js, fonts)
```

---

## Security notes

- The `/probe` and `/probe/stream` endpoints are intentionally
  unauthenticated — evaluating a chess position is this app's public,
  core functionality. `/admin` and `/admin/cache/*` are gated behind
  `ADMIN_TOKEN` (see below); every other route requires no credential.
- **Rate limiting** on `/probe` and `/probe/stream` is controlled by
  `PROBE_RATE_LIMIT`, and on `/admin/login` separately by
  `ADMIN_LOGIN_RATE_LIMIT` (both in `config.py`'s "Rate limiting"
  section), each applied per client IP via
  [flask-limiter](https://flask-limiter.readthedocs.io/). A client over
  either limit gets a `429` with a JSON error body. `PROBE_RATE_LIMIT`'s
  default, `"60 per minute"`, comfortably covers normal browsing and
  autoplay at its default delay — raise it if legitimate autoplay at a
  fast delay setting gets throttled, lower it if the deployment sees
  abuse, or set either limit to `""` to disable it entirely.
  `ADMIN_LOGIN_RATE_LIMIT` defaults to `"5 per minute"`, tight enough to
  slow down repeated `ADMIN_TOKEN` guesses. Both limiters key on
  `request.remote_addr` as corrected by `TRUSTED_PROXY_COUNT` (see
  below) and their state lives in-process (`memory://`), which is
  sufficient for a single-container deployment (e.g. one Render Web
  Service instance) but isn't shared across multiple replicas.
- **`TRUSTED_PROXY_COUNT`** (`config.py`'s "Rate limiting" section) is
  what `request.remote_addr` — and therefore both rate limiters above —
  is corrected against, so it reads the real client IP from
  `X-Forwarded-For` rather than the address of whichever reverse proxy
  sits in front of this app. The same setting also governs whether
  `X-Forwarded-Proto` is trusted, correcting `request.scheme` /
  `request.is_secure` (and any externally-generated URL) when TLS
  terminates at that reverse proxy rather than at this app itself. In
  production (`DEBUG = False`) this configures [waitress's own `trusted_proxy_count`](https://docs.pylonsproject.org/projects/waitress/en/stable/proxy-headers.html) —
  waitress parses both headers and corrects `REMOTE_ADDR`/`wsgi.url_scheme`
  itself, before Flask ever sees the request, so it takes priority here.
  [Werkzeug's `ProxyFix`](https://werkzeug.palletsprojects.com/en/latest/middleware/proxy_fix/)
  makes the equivalent correction for the `DEBUG = True` Flask-dev-server
  path, which doesn't run under waitress at all. Defaults to `1`,
  matching this project's own `render.yaml` topology; set it to match
  your own deployment if that differs, or to `0` for a deployment with no
  reverse proxy in front of it at all.
- **Admin access** is controlled by `ADMIN_TOKEN` (`config.py`'s "Admin"
  section), read from the environment rather than hardcoded — set it as
  a platform secret (e.g. a Render environment variable, generated
  automatically by `render.yaml`'s `generateValue: true`) rather than
  committing it. Visiting `/admin` with no active session shows a login
  form; a correct token there starts a signed, `HttpOnly`,
  `SameSite=Lax` session cookie (`Secure` too, on a deployment that sets
  `SESSION_COOKIE_SECURE` — see below). API clients can instead send
  `Authorization: Bearer <ADMIN_TOKEN>` directly, no session needed.
  Token comparison uses `hmac.compare_digest` (constant-time, resistant
  to timing attacks). Leaving `ADMIN_TOKEN` unset does **not** open the
  admin panel to everyone — every admin route responds `503` instead.
- **`SESSION_COOKIE_SECURE`** (`config.py`'s "Admin" section, also
  readable from a `SESSION_COOKIE_SECURE` env var) controls whether the
  admin session cookie above requires HTTPS, independently of `DEBUG` —
  `DEBUG` is a development/runtime behavior switch, not a reliable
  indicator of the deployment's transport security, so `DEBUG = False`
  alone doesn't imply HTTPS is actually in front of this app. Defaults to
  `False`, matching this project's documented plain-HTTP local
  deployment. Set the env var to `true` for any deployment the browser
  reaches over HTTPS (including behind a TLS-terminating reverse proxy —
  the browser's own connection is what the `Secure` attribute governs,
  not the internal hop between the proxy and this process); this
  project's own `render.yaml` already does that for a Render deployment.
  Leaving it `False` on an HTTP deployment is what makes `/admin/login`
  work at all — a `Secure` cookie set over plain HTTP is simply dropped
  by the browser, so `/admin/login` would appear to succeed while every
  subsequent authenticated `/admin/*` request came back `401`.
- The app serves via **waitress**, a production-grade WSGI server, by
  default (`DEBUG = False` in `config.py`) — see [Running in production](#running-in-production).
  Only set `DEBUG = True` (which switches to Flask's own dev server) for
  local development, never for anything reachable from another machine.
- A `Content-Security-Policy` is set on every response: scripts and fonts
  are restricted to `'self'` (no inline scripts, no third-party sources);
  styles allow `'self'` plus `'unsafe-inline'` (needed for a handful of
  inline `style="..."` attributes in `index.html`/`admin.html`); images
  allow `'self'` plus `data:`; `connect-src`/`default-src` are `'self'`
  too, so `fetch`/SSE calls can only reach this same origin. `object-src`,
  `base-uri`, and `form-action` are locked to `'none'`/`'self'`/`'self'`,
  and `frame-ancestors 'none'` is the CSP-native counterpart to the
  `X-Frame-Options: DENY` set alongside it. `X-Content-Type-Options:
  nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` are set
  too. Request bodies are capped at 4 KB.
- `config.py` itself holds no secrets — `ADMIN_TOKEN` and
  `FLASK_SECRET_KEY` are the only two values sourced from the
  environment rather than hardcoded, specifically so the file stays safe
  to commit as-is. Every other setting is a plain, non-sensitive value.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every probe returns "Position not covered by the loaded tablebase." | `TABLEBASE_PATH` is unset or wrong, or the position's piece count or castling right isn't covered by the currently configured tier — 7-8 piece positions need `TABLEBASE_PATH_7_8`, castling-rights positions need `TABLEBASE_PATH_CASTLING` (see [Configuration reference](#configuration-reference)). Check the startup log for "Tablebase opened at: ..." or a warning. |
| A FEN is rejected with "Invalid castling availability" (backend) or "Castling rights are not supported" (board UI) | The submitted castling-availability field is something other than `-` or a combination of `K`, `Q`, `k`, `q`, or names a castling right without a matching king and rook on their home squares. |
| `/health` returns `503 degraded` | The tablebase failed to open — check `TABLEBASE_PATH` and file permissions. |
| `ModuleNotFoundError: No module named 'chess.chesstb'` | Plain PyPI `chess` was installed instead of the fork. Re-run `pip install -r requirements.txt` and confirm it pulled `chess` from `noobpwnftw/python-chess` (the `add-chesstb-tablebases` branch) rather than plain PyPI `chess` — see the note at the top of `requirements.txt`. |
| `ModuleNotFoundError: No module named 'config'` | `config.py` is missing from alongside `app.py`. It ships with the repository — if it was deleted or moved, restore it from the repo (or re-clone) and re-apply any edits, such as `TABLEBASE_PATH`. |
| App logs `Configuration error: ...` and exits immediately | A value in `config.py` is the wrong type or out of range for that setting (e.g. a string where an integer is expected, or a negative cache size) — the error message names which setting and why. Fix it in `config.py` and re-run `python app.py`. |
| Admin dashboard panels stuck on "Loading…" | Check the browser console for a CSP violation, or that the app itself is actually running and reachable at the URL you're loading `/admin` from. |
| A drag, drop, or spare-piece placement on the board is silently rejected | The board is Locked — the padlock button beside the FEN box is highlighted gold. Lock restricts board interaction to legal moves and disables the spare-piece trays and off-board drops; click the padlock again to unlock and edit freely. |
| Probing feels slow on positions with many legal moves, or doesn't scale with `PROBE_THREADS` | Confirm `lz4` is actually installed (`pip show lz4`, or `python -c "import lz4"`) — without it, `chess.chesstb`'s block decompression runs in pure Python and holds the GIL, so `PROBE_THREADS` can't achieve real parallelism. `pip install lz4` (already in `requirements.txt`) and restart. Otherwise, tune `PROBE_THREADS`, `PROBE_PARALLEL_THRESHOLD`, and `PROBE_TIMEOUT_SECS` in `config.py`. Note that `chess.chesstb` guards the first open of a given material with a per-kind lock (one lock shared by every material of that *kind* — wdl, dtz, dtc, dtm, or dtm50 — with double-checked locking around the open itself), so two threads racing to open the *same* never-before-seen material collapse onto one read; what that lock doesn't do is separate different materials of the same kind, so several distinct never-before-seen materials of one kind still open one at a time rather than concurrently — this only affects the very first probe against any given material. |
| `ModuleNotFoundError: No module named 'waitress'` | The active environment's dependencies are out of date — re-run `pip install -r requirements.txt` to pick up `waitress`. `app.py` imports it unconditionally at the top of the file, before `config.DEBUG` is even read, so setting `DEBUG = True` does **not** avoid this — waitress has to be installed either way. |
| Every probe on a remote `TABLEBASE_PATH` returns "Position not covered..." or `/health` is `degraded` | Confirm the URL is reachable and correct (try opening `TABLEBASE_PATH/wdl/KQK.lzw` — or any small material's `.lzw` — directly in a browser). Check the startup log's "Tablebase opened remotely at: ..." line (or a warning in its place) for the actual failure. |
| A probe occasionally returns `503` with `error_code: "probe_timeout"` | Another concurrent request was already probing the same position and didn't finish within `PROBE_TIMEOUT_SECS`. This is transient and retryable — the original probe has usually landed in the child-probe cache by the time you retry, so the retry is cheap. Frequent occurrences suggest raising `PROBE_TIMEOUT_SECS`, or that a slow remote `TABLEBASE_PATH` is the underlying bottleneck. |
| Remote probing feels slow, or repeated probes against the same material keep hitting the network | Check `REMOTE_TIMEOUT_SECS`/`REMOTE_MAX_RETRIES` aren't causing retries on a slow link, and consider raising `REMOTE_PAGE_CACHE_BYTES` — a too-small budget evicts cached pages (`"direct"`) or downloaded files (`"download"`) before later probes can reuse them. `GET /admin/cache/stats` surfaces this as `tablebase_cache.remote_page_cache` or `.remote_disk_cache` respectively, alongside `tablebase_remote_mode`. On a high-latency link also try raising `REMOTE_PAGE_SIZE_BYTES`, or `REMOTE_MODE = "download"`. See [Configuration reference](#configuration-reference). |
| On Render, the deploy never goes live / stays stuck "deploying" | Render's health check (`healthCheckPath: /health` in `render.yaml`, or the equivalent field on a manually-created service — see [Deploying to Render](#deploying-to-render)) only passes once `/health` returns `200`, which itself requires at least one of `TABLEBASE_PATH`, `TABLEBASE_PATH_7_8`, or `TABLEBASE_PATH_CASTLING` to have opened successfully. Check the service's **Logs** tab for the same "Tablebase opened remotely at: ..." / warning line described above. |
| On Render, the service responds but the page never loads / connection refused | Almost always a `PORT` mismatch. Confirm `config.py` reads `PORT` from the environment (see [Configuration reference](#configuration-reference)) and that nothing else in a custom start command overrides `HOST`/`PORT`. |

---

## Credits

- Tablebase data & format: [ChessTB / chessdb.cn](https://www.chessdb.cn/)
- Tablebase probing support: [noobpwnftw/python-chess (`add-chesstb-tablebases` branch)](https://github.com/noobpwnftw/python-chess/tree/add-chesstb-tablebases), a fork of [niklasf/python-chess](https://github.com/niklasf/python-chess)
- Remote (URL) tablebase support for the fork's `chess.chesstb` module — see `remote/remote_source.py`, `remote/remote_direct.py` and `remote/remote_fallback.py`
- Board UI: [Chessground](https://github.com/lichess-org/chessground)
- Move generation/validation on the client: [chess.js](https://github.com/jhlywa/chess.js)
- Production WSGI server: [waitress](https://docs.pylonsproject.org/projects/waitress/)
- Piece set: [cburnett](https://github.com/lichess-org/lila/blob/master/COPYING.md), a commonly-used community set found in most web chess UIs.

