# ChessTB Explorer ♟️

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://chesstb-explorer-render.onrender.com)

A single-page web application for exploring **ChessTB** chess endgame
tablebases. Paste or build any position on an interactive board and
instantly see every legal move ranked by **Distance to Zeroing (DTZ)**,
**Distance to Conversion (DTC)**, **Distance to Mate (DTM)**, and **DTM
under the 50-move rule (DTM50)** - straight from the tablebase, with no
chess engine involved.

The backend is a small Flask application that probes the tablebase through
a modified fork of [`python-chess`](https://github.com/noobpwnftw/python-chess/tree/add-chesstb-tablebases)
(the `chess.chesstb` module - see [Installation](#installation)). The frontend is
a React app built around
[Chessground](https://github.com/lichess-org/chessground) (lichess.org's
board component) and [chessops](https://github.com/niklasf/chessops) for
move generation/validation, supporting both Standard chess and Chess960
(Fischer Random).

> This tool only *displays* tablebase results - it does not generate,
> verify, or ship any tablebase data itself. See
> [Getting the tablebase files](#getting-the-tablebase-files) below.

> The probe endpoints are unauthenticated by design - evaluating a
> position is this app's public functionality. The `/admin` cache
> dashboard is gated behind `ADMIN_TOKEN`, a secret configured by the deployment
> (see [Security notes](#security-notes)).

---

## Features

- **Interactive board**: drag-and-drop moves, click-to-place pieces from
  the spare-piece trays, pawn promotion dialog, board flip (orientation
  persisted locally across visits), undo/redo.
- **Chess960 (Fischer Random) support**: a **Chess960 Mode** switch in
  the settings panel changes castling interpretation without altering the
  current board position: dragging a king onto its own rook castles the
  Chess960 way, and X-FEN/Shredder-FEN rook-file castling-rights letters
  (e.g. `HAha`) are accepted in the FEN box. Carried through the shared
  URL (`&variant=chess960`), the saved in-progress game, and PGN
  import/export (`[Variant "Chess960"]`). Off by default.
- **Lock**: a padlock button beside the FEN box that restricts board
  interaction to legal moves only: dragging, click-to-move, and the
  spare-piece trays are limited to the side to move's legal destinations,
  and off-board drops are disabled. Unlocked by default; a manual toggle
  is remembered locally across visits. Auto-play also engages Lock for
  the duration of a run (unless already locked by hand), and disables the
  padlock button until the run stops.
- **Four ranked move tables side by side**: DTZ, DTC, DTM, and DTM50
  columns, each independently sorted best-move-first, with:
  - score text colour-coded by outcome (win / cursed win / draw /
    blessed loss / loss)
  - a **warning dot** on any move flagged cursed win or blessed loss,
    with a hover tooltip explaining the 50-move-rule nuance; a DTZ score
    that may still be a ply off after the moves are cross-checked shows a
    second tooltip line
  - an **info dot** on a draw by insufficient material, keeping the score
    text itself reading as a plain "Draw"
  - dot messages on touch or pen input: tapping a dot shows its tooltip
    text as a notice and does not play the move
  - an outcome summary (wins / draws / losses / unknown) for the position
  - an optional pinned **Root Row** above rank 1, showing the current
    position's own score for each metric as a reference point - toggled
    from the settings panel (**Show Root Row**, off by default) and
    persisted locally
- **Best-move arrows**: the top DTZ, DTC, DTM, and DTM50 moves are drawn
  as colour-coded arrows directly on the board.
- **Auto-play**: automatically plays the best move for any of the four
  metrics on a timer. The per-move delay
  is set from the settings panel (**Autoplay Delay**, 0s–2.5s in 50ms
  steps, 1.25s by default) and acts as a floor - a move that's still
  waiting on its tablebase probe takes as long as the probe does,
  regardless of the delay setting. A metric's button is disabled when its
  table isn't present for the current material, or when the position is
  already a draw.
- **PGN import/export**: paste a PGN to load a game and click through its
  moves, or copy the current line as PGN.
- **CSV export** of the current move table, including the Root Row line
  ahead of rank 1 when that setting is on.
- **Move-list / PGN panel** with full undo/redo and click-to-jump - jumping
  to an earlier point in the line re-uses the cached probe instead of
  re-querying the tablebase.
- **Shareable positions**: the FEN (and, in Chess960 Mode, the active
  variant) is written to the URL hash on every move, so a link to the
  page reproduces the exact position and ruleset.
- **Session persistence**: the in-progress game (not just the position)
  survives a trip to the admin dashboard and back.
- **Board and piece set**: Libre Brown board, CBurnett piece set.
- **Streaming probes**: `/probe/stream` reports progress via
  Server-Sent Events while child positions are being probed, so the UI
  shows a live progress bar instead of a blank pause on slower lookups.
- **Hover pre-fetch**: hovering a move in the table warms the cache for
  the resulting position before selection.
- **Admin cache dashboard** (`/admin`, behind `ADMIN_TOKEN`) - live
  hit-rate stats for both LRU caches, thread-pool configuration, and a
  one-click cache-clear button.
- **Machine-readable API**: the full HTTP API is described by an OpenAPI
  3.0 document served at `/openapi.yaml`.
- **Keyboard shortcuts**: `Enter` Apply, `F` Flip, `C` Clear, `←`/`→`
  Back/Forward. The Board Settings panel lists them on devices with hover.

---

## Architecture at a glance

```
Browser (React app - see frontend/)
  ├─ engine/board.js      - chessops-backed position/rules state, chessground
  │                           wrapper (drag/drop, history, arrows), active variant
  ├─ engine/tablebase.js  - talks to /probe/stream, exposes results as state
  ├─ engine/theme.js      - board/piece-set theming
  ├─ hooks/useExplorer.js - FEN box, PGN, auto-play, settings, keyboard shortcuts
  └─ components/          - the rendered page (board, results table, PGN panel, dialogs)
        │  HTTP (JSON) / SSE (text/event-stream) - {fen, variant}
        ▼
Flask app (app.py)
  ├─ /probe, /probe/stream   - evaluate a FEN under a variant, rank every legal move
  ├─ /admin, /admin/cache/*  - cache dashboard + stats API
  └─ /openapi.yaml           - API specification
        │
        ▼
tablebase_router.py - routes each probe by piece count and castling
rights across up to three independently-opened sources: TABLEBASE_PATH,
TABLEBASE_PATH_7_8, TABLEBASE_PATH_CASTLING (variant-agnostic - a
Chess960 board's castling rights route the same way a Standard board's do)
        │
        ▼
chesstb.open_tablebase(...) per source   (noobpwnftw's modified python-chess fork)
        │
        ▼
ChessTB tablebase files - local disk, or a remote http(s) URL (probed
in place over byte ranges by default, or downloaded and cached to local
disk per material - see remote/remote_direct.py, remote/remote_fallback.py,
and "Getting the tablebase files" below)
```

The React app is built with Vite into `static/dist/` (`app.js`,
`app.css`), which the Flask template loads as same-origin assets, as the
Content-Security-Policy (`script-src 'self'`) requires. See
[Frontend build](#frontend-build) below.

This covers the main explorer page's (`index.html`) module graph - see
[Project structure](#project-structure) below for the complete file set,
including `admin.js` (the `/admin` dashboard's client script, a plain
server-rendered page with no build step).

The Python modules and the frontend `engine/` modules carry a file-level
docstring/header comment describing their responsibilities, and the
move-ranking algorithm itself - including
its treatment of the 50-move rule - is documented inline in `app.py`
above `evaluate_all_moves()` and the `_effective_move_wdl`/
`_effective_distance`/`_order_rank` helpers it calls.

---

## Frontend build

The explorer page is a React app (`frontend/`) built with Vite into
`static/dist/`, which the Flask app serves alongside its own
static assets. The build output is checked in, so running the app needs
no frontend server or build step. Rebuild after changing anything under
`frontend/src/`:

```bash
cd frontend
npm ci
npm run build      # writes static/dist/app.js, app.css, admin.css, fonts/
```

`frontend/src/engine/` and `frontend/src/vendor/` hold the position/rules
engine (chessops + Chessground) and the tablebase client, consumed by
the React components in `frontend/src/components/`. Shared UI primitives
(`Icon`, `Button`, `Segmented`, `Panel`) are in `frontend/src/components/ui/`.
Piece SVGs and the piece-set stylesheet are in `static/` and are linked
directly from the page template.

### Styling

Stylesheets are in `frontend/src/styles/` and are bundled by Vite into
`static/dist/app.css` (explorer page) and `static/dist/admin.css` (`/admin`).
`tokens.css` defines the colour, type, spacing, radius, elevation, motion,
and control-size custom properties; other files reference them instead of
literal values. Files are imported into the `reset`, `vendor`, and `app`
cascade layers by `index.css` and `admin.css`.

| Token group | Custom properties |
|---|---|
| Type scale | `--text-xs` 12 px, `--text-sm` 13 px, `--text-md` 14 px, `--text-lg` 16 px, `--text-xl` 20 px |
| Spacing | `--space-1` to `--space-6` (4 px to 32 px) |
| Controls | `--control-h`, `--control-h-sm` (44 px on touch-primary devices) |
| Board | `--board-light`, `--board-dark`, `--board-highlight`, read by `engine/theme.js` |

Sizes are authored in `rem`, so the large-screen root font size scaling
applies to all text and controls.

### Page layout

| Viewport | Layout |
|---|---|
| Above 1180 px | Three-column CSS grid (board, results, PGN). The results and PGN columns take the board column's height and scroll internally. |
| 768 to 1180 px | Board row above a results and PGN row; the page scrolls. |
| Below 768 px | Three horizontally swipeable screens (board, results, PGN) with a bottom navigation bar (`ScreenNav`). Header and navigation heights include the device safe-area insets, and screen heights use `dvh`. The header shows the subtitle below the title, and the board is sized to the visible height so the whole board screen fits. |

The side-to-move toggle and the board form one group (`.board-group`) as wide
as the board, with a fixed small gap between them at every screen size. Free
vertical space in the board column sits above the group.

The results panel is a `results` size container. At 38 rem wide and above it
shows the four metric columns; below that it shows one metric at a time,
selected with the metric tabs, regardless of viewport width. The results
table is a fixed header table above a scrolling body table, so the scrollbar
starts at the first moves row. The body reserves no scrollbar gutter: while
its rows overflow, its table is widened by the scrollbar's measured width, so
columns keep the header's position and width whether or not a scrollbar shows.
The PGN move-number column width is set by `--pgn-rank-w` in `tokens.css`.

### Display scaling

Sizing is CSS-only and is defined in `frontend/src/styles/layout.css`.

- **Text:** above 1180 px, the root font size of the explorer page
  (`html.explorer`) is 100% of the browser default up to a 1536 x 780 window
  and rises to at most 125% (20 px), following the window's width and
  height. Browser zoom and the browser default font size apply.
- **Board:** above 1180 px, `--board-size` fills the window height in
  multiples of 8 px, from 20.5 rem up to `--board-size-max` (720 px, defined
  in `tokens.css`), and leaves at least 40 rem for the results table. The
  left column is as wide as the board, so it is capped at 720 px as well.
  The width the board column does not use goes to the results column, so
  the total content width stays constant.
- **Tablet layout:** at 1180 px and below, the root font size is the
  browser default and `--board-size` is `--board-size-cap`, defined in
  `tokens.css` as
  `min(720px, clamp(18.75rem, min(23.4375vw, 41.6667vh), 31.5rem))`.
- **Phone layout:** below 768 px, `--board-size` is the smaller of
  `--board-size-cap` (`min(360px, 88vw)` up to 480 px wide) and the height
  that remains after the header, bottom navigation, and the controls
  above the board, with a floor of 14 rem. The board screen therefore
  fits the visible height regardless of browser toolbar size. Below the
  floor, the screen scrolls from its top.
- `--board-fit-h` includes the fixed height above the board in the left
  column and requires an update when that height changes. This applies to
  both the desktop definition in `layout.css` and the phone definition in
  `responsive.css`.
- `html.explorer` is set in `templates/index.html` and `frontend/index.html`.
  `/admin` does not use it.

---

## Prerequisites

- **Python 3.10+**
- **Git**, available on `PATH` - `pip install -r requirements.txt` fetches the
  `python-chess` fork directly from GitHub (`chess @ git+https://...`),
  which requires `git` to be installed even though the package itself is
  Python.
- **A ChessTB tablebase directory or URL**: either a local directory on
  disk, or an `http(s)://` base URL serving the same layout remotely with
  no local download (see [Getting the tablebase files](#getting-the-tablebase-files)).
  The app starts without one, but every probe will fail until
  `TABLEBASE_PATH` points at one of the two. `TABLEBASE_PATH_7_8` and
  `TABLEBASE_PATH_CASTLING` are optional extensions of the same setting;
  see [Configuration reference](#configuration-reference).
- A modern browser (the frontend uses `fetch`, `ReadableStream`, and CSS
  container queries).

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

3. **Get the tablebase files**: see the next section. When using the
   remote (no-download) option requires no fetch; continue to step 4 and
   point `TABLEBASE_PATH` at the URL.

4. **Configure `config.py`**: open it and set `TABLEBASE_PATH` to the
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

   Every other setting in `config.py` has a default and a comment
   explaining what it does - see
   [Configuration reference](#configuration-reference) for the complete
   list. Edit the values directly. To enable the header's GitHub button,
   set `GITHUB_URL` there too.

5. **Run the app:**

   ```bash
   python app.py
   ```

   By default (`DEBUG = False` in `config.py`) this serves the app via
   **waitress**, a production-grade pure-Python WSGI server - see
   [Running in production](#running-in-production) below. Set
   `DEBUG = True` in `config.py` to use Flask's development server
   (auto-reload, interactive debugger) for local development.

6. Open **http://127.0.0.1:7860** in a browser.

   The built frontend (`static/dist/`) is checked in; see
   [Frontend build](#frontend-build) when changing `frontend/src/`.

---

## Getting the tablebase files

Where the tablebase *data* lives is a separate question from where this
*app* runs - Option A below points `TABLEBASE_PATH` at a plain
`http(s)://` URL, so it works identically regardless of which platform
serves the app itself (Render, Hugging Face Spaces, a local machine,
etc.); `remote/remote_source.py` speaks plain HTTP byte-range requests,
nothing more, and has no dependency on any one host. See
[Deploying to Render](#deploying-to-render) for the app side of that
distinction.

ChessTB tablebase files are available two ways:

### Option A: Remote, no local download (recommended)

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
generator produces directly - 3-6 piece material only, but faster to probe
than the shrunk set.

Raw file bytes for a bucket path are served from the matching
`/resolve/<path>` URL. The recommended setup points each of the three
`TABLEBASE_PATH*` settings at the fastest part of that layout for its
material - `full/` for 3-6 piece and castling-rights material, the bucket
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
covering every piece count, without the `full/` speed advantage on
3-6 piece material and without castling-rights coverage (castling tables
live only under `castling/`, not alongside the plain material files).

However many of the three are set, the app probes tables over HTTP.
`REMOTE_MODE` selects the remote access mode, which stays fixed for the
life of the process:

- **`"direct"` (default)**: `remote/remote_direct.py` probes the remote
  tables **in place**, fetching only the `REMOTE_PAGE_SIZE_BYTES`-sized
  byte ranges each probe reads and keeping them in an in-memory
  LRU bounded by `REMOTE_PAGE_CACHE_BYTES`. Nothing is written to disk.
  This uses `chess.chesstb`'s table-source seam
  (`Tablebase.WDL_FILE` / `_TableFile._open_source`), which the pinned
  fork (see `requirements.txt`) provides.
- **`"download"`**: `remote/remote_fallback.py` fetches each table
  **in full** the first time a probe touches its material and caches it
  in a temporary local directory (bounded by
  `REMOTE_PAGE_CACHE_BYTES` as an on-disk budget, evicting
  least-recently-used files, removed entirely when the app stops). Every
  probe after the first is then a local mmap read.

`"direct"` is the better default for browsing across many materials, which
is what this app does. `"download"` is preferable when a long session
repeatedly probes a small set of materials, or on a high-latency link: a
ChessTB probe is not a narrow read - a dropped-frame table is reconstructed by walking
its children, and pawn positions reach promotion sub-tables - so one cold
probe can open several materials and issue several fetches against each.
That is also why `REMOTE_PAGE_SIZE_BYTES` should stay large. See each
module's docstring for the full design.

Remote access suits a machine without a couple of terabytes of local disk
for the full tablebase set. Its costs are probe latency on first touch of
any given material (depending on the connection to the CDN), temporary
local disk usage in `"download"` mode, and the requirement of a network
connection. Remote access uses the `requests` package (see
`requirements.txt`).

### Option B: Local directory, over FTP

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

Tablebase sets are large and grow quickly with piece count - check
available disk space before mirroring the full archive, and consider
mirroring only the required subsets (piece counts). Point
`TABLEBASE_PATH` at the selected directory.

---

Regardless of how it is configured, if `TABLEBASE_PATH` is unset, missing/unreachable, or
points at a location with no usable tables, the app still starts (with a
warning in the logs) - every `/probe` request will then return an error,
and `/health` reports `"degraded"`. Leaving `TABLEBASE_PATH_7_8` or
`TABLEBASE_PATH_CASTLING` unset isn't an error condition - it routes
the material each would have covered through `TABLEBASE_PATH` instead, as
described above.

---

## Configuration reference

All configuration lives in **`config.py`**, as plain Python values. Open
it and edit the settings directly - each one has a comment above it
explaining what it does. The table below is the complete reference.

| Setting                     | Default          | Description |
|-----------------------------|-------------------|-------------|
| `TABLEBASE_PATH`            | `""` (also readable from a `TABLEBASE_PATH` env var) | Directory containing the ChessTB tablebase files, **or** an `http(s)://` base URL serving the same layout remotely (e.g. a Hugging Face storage bucket - see [Getting the tablebase files](#getting-the-tablebase-files)). Required for probing to work. A list of directories and URLs, tried left-to-right (a hybrid source), is accepted as a literal in `config.py` only. On Render, set this from the service's Environment tab (or `render.yaml`'s prompt) instead of editing the file. |
| `TABLEBASE_PATH_7_8`        | `""` (also readable from a `TABLEBASE_PATH_7_8` env var) | Same accepted forms as `TABLEBASE_PATH`, covering 7-8 piece material specifically. Left empty, 7-8 piece positions are routed through `TABLEBASE_PATH` instead. |
| `TABLEBASE_PATH_CASTLING`   | `""` (also readable from a `TABLEBASE_PATH_CASTLING` env var) | Same accepted forms as `TABLEBASE_PATH`, covering castling-rights positions specifically, independent of piece count and independent of variant - a Chess960 position with a usable castling right routes here exactly the same way a Standard one does (see `tablebase_router.py`). Left empty, such a position is routed through `TABLEBASE_PATH`/`TABLEBASE_PATH_7_8` by piece count instead, which only resolves it if that tablebase happens to carry castling-rights tables too. |
| `DEBUG`                     | `False`           | `True` runs `app.py` via Flask's own dev server (auto-reload, detailed tracebacks) instead of waitress. Leave `False` - which serves via waitress - for anything reachable from another machine. See [Running in production](#running-in-production). |
| `HOST`                      | `"0.0.0.0"`       | Interface the server (waitress, or the dev server if `DEBUG = True`) binds to. |
| `PORT`                      | `7860` (also readable from a `PORT` env var) | Port the server listens on. Render injects its own `PORT` at deploy time and this picks it up automatically - nothing to set for a Render deployment. |
| `WAITRESS_THREADS`          | `4`               | Worker threads in waitress's request-handling pool. Only relevant when `DEBUG = False`. Needs to be more than 1 so a long-lived `/probe/stream` connection can't block other requests. |
| `PROBE_THREADS`             | `2`               | Worker threads in the probe thread pool for evaluating a position's legal moves in parallel. Set an explicit integer to match the host's CPU count, or `None` to scale automatically (`min(16, cpu*2)`). |
| `PROBE_PARALLEL_THRESHOLD`  | `4`               | Minimum number of child positions before probing switches from sequential to the thread pool. |
| `PROBE_TIMEOUT_SECS`        | `30`              | Wall-clock timeout for each probe phase. `/probe` gives the root probe and the child-move batch independent budgets, so worst-case `/probe` latency can approach `2 × PROBE_TIMEOUT_SECS`. Also bounds how long a request waits on another thread's in-flight probe of the same FEN before giving up with a retryable `probe_timeout` error. |
| `EVALUATE_CACHE_SIZE`       | `4096`            | Max entries in the root-FEN result cache (full JSON responses). |
| `PROBE_CACHE_SIZE`          | `16384`           | Max entries in the child-position probe cache (raw `chess.chesstb.ProbeResult` objects - WDL/DTZ/DTC/DTM/DTM50 together). |
| `BLOCK_CACHE_BYTES`         | `67108864` (64 MiB) | Size, in bytes, of `chesstb`'s own internal cache of decoded/decompressed tablebase blocks (shared across the WDL/DTZ/DTC/DTM/DTM50 tables). Raising this trades RAM for fewer repeated disk reads/HTTP fetches + decompressions across a session - most worthwhile when `PROBE_PARALLEL_THRESHOLD` is set high enough that probing runs mostly serially. |
| `REMOTE_MODE`               | `"direct"`        | **Remote tablebase entries only.** `"direct"` probes the remote tables in place over byte ranges (nothing written to disk); `"download"` fetches each table in full on first touch and caches it on local disk. See [Getting the tablebase files](#getting-the-tablebase-files). |
| `REMOTE_PAGE_CACHE_BYTES`   | `134217728` (128 MiB) | **Remote tablebase entries only.** Soft budget, in bytes, shared across every remote table opened this session: the in-memory page cache in `"direct"` mode, the on-disk cache of whole downloaded files in `"download"` mode. See [Getting the tablebase files](#getting-the-tablebase-files). |
| `REMOTE_PAGE_SIZE_BYTES`    | `262144` (256 KiB) | **Remote tablebase entries only.** Size, in bytes, of one page. In `"direct"` mode this is the granularity of every fetch, so it trades over-fetching against round trips per probe; in `"download"` mode it is only the chunk size used while streaming a full file down. |
| `REMOTE_TIMEOUT_SECS`       | `20`              | **Remote tablebase entries only.** Per-HTTP-request timeout for existence/size checks and the download itself. |
| `REMOTE_MAX_RETRIES`        | `3`               | **Remote tablebase entries only.** Attempts for a single remote request before it's treated as failed. |
| `REMOTE_POOL_MAXSIZE`       | `None`            | **Remote tablebase entries only.** Size of each remote backend's HTTP connection pool. `None` computes `max(PROBE_THREADS * 2, 20)`. |
| `PROBE_RATE_LIMIT`          | `"60 per minute"` | Per-client-IP request limit on `/probe` and `/probe/stream`, using [flask-limiter](https://flask-limiter.readthedocs.io/)'s string syntax. Left empty, rate limiting is disabled entirely. See [Security notes](#security-notes). |
| `ADMIN_LOGIN_RATE_LIMIT`    | `"5 per minute"`  | Per-client-IP request limit on `/admin/login`, same string syntax as `PROBE_RATE_LIMIT`, applied independently of it. Covers both failed and successful login attempts. Left empty, login attempts are not rate limited. See [Security notes](#security-notes). |
| `PREFETCH_RATE_LIMIT`       | `"30 per minute"` | Per-client-IP request limit for hover prefetch requests marked with `X-Prefetch: 1`. Left empty, prefetch requests share `PROBE_RATE_LIMIT`. See [Security notes](#security-notes). |
| `TRUSTED_PROXY_COUNT`       | `1` (also readable from a `TRUSTED_PROXY_COUNT` env var) | Number of trusted reverse-proxy hops in front of this app. In production this configures [waitress's own `trusted_proxy_count`](https://docs.pylonsproject.org/projects/waitress/en/stable/proxy-headers.html) (waitress parses `X-Forwarded-For`/`X-Forwarded-Proto` and corrects `REMOTE_ADDR`/`wsgi.url_scheme` itself, ahead of Flask); [Werkzeug's `ProxyFix`](https://werkzeug.palletsprojects.com/en/latest/middleware/proxy_fix/) makes the same correction for the `DEBUG = True` dev-server path, which doesn't run under waitress. Both rate limiters key on the corrected address, and `request.scheme`/`request.is_secure` read the corrected scheme. `1` matches this project's own `render.yaml` topology (Render's edge/load-balancer, once). Set it to match the deployment's reverse-proxy chain, or set it to `0` for a deployment with no reverse proxy in front of it at all. See [Security notes](#security-notes). |
| `ADMIN_TOKEN`                | `""` (from `ADMIN_TOKEN` env var) | Shared secret required to reach `/admin` and `/admin/cache/*`. Read from the environment rather than hardcoded, so it can be set as a platform secret. Left unset, admin routes respond `503` rather than running unprotected. See [Security notes](#security-notes). |
| `FLASK_SECRET_KEY`           | `""` (from `FLASK_SECRET_KEY` env var) | Key used to sign the admin session cookie. Read from the environment for the same reason as `ADMIN_TOKEN`. Left unset, a random key is generated at process startup instead, so every restart requires logging in again. |
| `SESSION_COOKIE_SECURE`      | `False` (also readable from a `SESSION_COOKIE_SECURE` env var, `"true"`/anything else) | Whether the admin session cookie set by `/admin/login` requires HTTPS. Independent of `DEBUG`. Defaults `False` to match a plain-HTTP local installation; set to `"true"` for any deployment the browser reaches over HTTPS (including behind a TLS-terminating reverse proxy such as Render's - `render.yaml` already sets this explicitly for that deployment). See [Security notes](#security-notes). |
| `GITHUB_URL`                 | `""` (also readable from a `GITHUB_URL` env var) | Repository URL for the GitHub button shown in the header of every page. Edited directly like any other non-secret value here, or set as an env var on a given deployment. Left empty, the button is omitted. |

Invalid values (wrong type, out of range) cause the app to log an error
and exit at startup rather than run with a silently-wrong configuration.

---

## Running in production

`python app.py` serves the app via **[waitress](https://docs.pylonsproject.org/projects/waitress/)**,
a production-grade, pure-Python WSGI server, whenever `DEBUG` in
`config.py` is `False` (the default) - no separate `gunicorn`/`waitress`
command or extra process is needed on top of the app itself. Setting
`DEBUG = True` in `config.py` switches `app.py` over to Flask's own dev
server instead (auto-reload + interactive debugger), which is meant for
local development only and should not be used for anything reachable
from another machine.

```bash
# Production (default): DEBUG = False in config.py: serves via waitress
python app.py

# Local development: set DEBUG = True in config.py first, then run the
# same command: Flask dev server, auto-reload + debugger
python app.py
```

- `HOST` / `PORT` control the interface and port waitress binds to, same
  as for the dev server. `PORT` is also readable from a `PORT`
  environment variable (see [Configuration reference](#configuration-reference)),
  which is what lets the same image bind correctly on Render - or any
  other platform that assigns the port at deploy time - with no edits.
- `WAITRESS_THREADS` (default `4`) sizes waitress's own pool of
  request-handling threads. This needs to be more than 1 for the same
  reason the dev server needs `threaded=True`: `/probe/stream` holds a
  connection open via Server-Sent Events for the whole duration of a
  probe, and a single-threaded server would let that one connection block
  every other request - including the browser's own concurrent requests
  for CSS/JS/piece images on first page load. It's independent of
  `PROBE_THREADS`, which sizes the thread pool used internally to
  parallelise tablebase probing rather than to serve HTTP requests.
- `TRUSTED_PROXY_COUNT` (default `1`) configures waitress's own
  `trusted_proxy_count`, so `request.remote_addr` and `request.scheme`
  reflect the real client IP and scheme behind Render's edge/load-balancer
  rather than that proxy's own address/hop - see
  [Security notes](#security-notes).
- Waitress handles `/probe/stream`'s streamed response natively; no
  additional configuration is needed for SSE to work correctly.
- The probe endpoints are unauthenticated by design; only `/admin` and
  `/admin/cache/*` require a credential (see
  [Security notes](#security-notes)).

---

## Deploying to Render

This project deploys to [Render](https://render.com) as a single Docker
web service, built straight from this GitHub repository. Render watches
the connected branch and rebuilds/redeploys automatically on every push.

There are two ways to set it up:

### Option 1: Blueprint (`render.yaml`, recommended)

This repository ships a [`render.yaml`](render.yaml) at its root
describing the service (Docker runtime, health check, environment
variables). Render finds it automatically:

1. Push this repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click
   **New → Blueprint** and connect the repo.
3. Render reads `render.yaml` and requests the one setting required
   before the first deploy can run: **`TABLEBASE_PATH`** - the
   `http(s)://` base URL of the remote tablebase (see
   [Getting the tablebase files](#getting-the-tablebase-files)).
   `ADMIN_TOKEN` and `FLASK_SECRET_KEY` are generated automatically.
4. Click **Apply** / **Create**. Render builds the image from this
   repo's `Dockerfile` and deploys it.

Every subsequent push to the connected branch redeploys automatically.
To change `TABLEBASE_PATH`, `ADMIN_TOKEN`, or any other setting later,
edit it from the service's **Environment** tab in the Render Dashboard;
see [Configuration reference](#configuration-reference) for which
settings are env-overridable this way versus which live only in
`config.py`.

### Option 2: Manual Web Service (no `render.yaml`)

The service can also be configured manually without the Blueprint file:

1. Push this repository to GitHub.
2. In the Render Dashboard, click **New → Web Service** and connect the
   repo.
3. Set **Runtime** to **Docker** (Render should detect the `Dockerfile`
   at the repo root automatically).
4. Under **Environment**, add:
   - `TABLEBASE_PATH`: required; same as Option 1 above.
   - `TABLEBASE_PATH_7_8`, `TABLEBASE_PATH_CASTLING`: optional; add
     either to extend coverage to 7-8 piece material or castling-rights
     positions from a separate source. Leaving them unset routes that
     material through `TABLEBASE_PATH` instead (see
     [Configuration reference](#configuration-reference)).
   - `ADMIN_TOKEN`: optional but recommended; any secret string, or
     use Render's "Generate" button. While it is unset, `/admin`
     responds `503`.
   - `FLASK_SECRET_KEY`: optional; when omitted, a random key is
     generated at process startup and admin sessions don't survive a
     restart.
   - `SESSION_COOKIE_SECURE`: set to `true`. Render always terminates
     TLS at its edge, so the browser reaches this deployment over HTTPS
     even though the app itself just speaks plain HTTP to Render's
     proxy; `config.py`'s own default (`false`) is tuned for a local
     plain-HTTP installation instead. (Option 1's `render.yaml` sets
     this automatically - it is a manual step here because Option 2
     skips that file.)
   - `GITHUB_URL`: optional; the repository URL, which enables the
     header's GitHub button.
   - Leave `PORT` alone - Render sets it itself, and `config.py` already
     reads it (see [Configuration reference](#configuration-reference)).
5. Under **Health Check Path**, set `/health` (matches the route in
   `app.py`; Render won't mark a deploy healthy until this returns `200`,
   which itself only happens once at least one of `TABLEBASE_PATH`,
   `TABLEBASE_PATH_7_8`, or `TABLEBASE_PATH_CASTLING` has opened
   successfully).
6. Click **Create Web Service**.

### Choosing a plan

Probing is CPU-bound (block decompression on every request), so a
dedicated vCPU - Render's **Starter** tier or above - gives lower probe
latency than the **Free** tier's shared/limited CPU. Free works
for casual or low-traffic use; the service spins down after inactivity
(a slow first request after waking up) and probes are slower under load. Either way, `REMOTE_MODE = "direct"` (the default)
means no persistent disk is needed regardless of plan - see
`config.py`'s "Remote (URL) tablebase entries only" section and
[Getting the tablebase files](#getting-the-tablebase-files).

---

## Usage guide

- **Set a position**: type or paste a FEN into the FEN box and press
  `Enter` or **Apply**. The move rankings and best-move arrows update
  automatically. The castling-availability field accepts `-` or any
  combination of `K`, `Q`, `k`, `q` (each requiring a matching king and
  rook on their home squares); in **Chess960 Mode** it additionally
  accepts X-FEN/Shredder-FEN rook-file letters (`a`-`h` / `A`-`H`). A
  position with a castling right is evaluated the same as any other,
  reported as not covered if the loaded tablebase set has no table for it
  (see `TABLEBASE_PATH_CASTLING` in
  [Configuration reference](#configuration-reference)).
- **Chess960 (Fischer Random)**: toggle **Chess960 Mode** in the settings
  panel to switch castling interpretation. This does not move any pieces
  or randomize a new starting position - it only changes how castling
  moves/rights on the *current* board are interpreted, and drops the
  current move line the same way a board edit does (a line built under
  one variant isn't reinterpreted as the other). With it on, drag a king
  onto its own rook to castle; the destination square and resulting rook
  position follow standard Chess960 rules regardless of where the king
  and rook started. The setting is carried in the shared URL
  (`&variant=chess960`), the saved in-progress game, and PGN
  import/export (a `[Variant "Chess960"]` header).
- **Edit the board directly**: drag pieces around the board, drag a piece
  off the board to remove it, or click a spare piece in either tray and
  then click a square to place it (click again / press `Esc` to cancel).
  Board edits reset the current move line the same way **Clear** does.
- **Lock the board**: click the padlock button beside the FEN box to
  restrict drag-and-drop, click-to-move, and the spare-piece trays to
  legal moves for the side to move; the button turns gold while active.
  Click again to unlock. The choice is remembered locally across visits.
  Starting auto-play locks the board automatically for the run (unless
  already locked) and disables the padlock button until it stops.
- **Play moves**: click any move in one of the four ranked tables to
  play it, or drag a piece on the board through a legal move.
- **Navigate history**: the Undo/Redo arrow buttons or `←`/`→`, or click
  any move in the PGN panel to jump straight to that point in the line.
- **Auto-play**: click the ▶ button above the DTZ, DTC, DTM, or DTM50
  columns
  to have the app play that metric's best move on a timer (delay set by
  **Autoplay Delay** in settings, 1.25s by default); click again (the
  button shows ■ while running) to stop. Any manual navigation stops auto-play.
- **Import/export a game**: **Import** in the PGN panel opens a dialog to
  paste PGN text and jump to any parsed move; **Copy** copies the current
  line as PGN with standard headers.
- **Export the move table**: the **CSV** button downloads the current
  DTZ/DTC/DTM/DTM50 rankings as a CSV file.
- **Share a position**: the URL updates live with `#fen=...`; sending
  that link reproduces the exact position.
- **Change settings**: the ⚙ button in the header opens a **Show Root
  Row** switch for the results table, a **Chess960 Mode** switch, and an
  **Autoplay Delay** slider; the choices are persisted across visits.
- **Admin dashboard**: the gauge icon in the header opens `/admin`, prompting for the
  `ADMIN_TOKEN` on first visit, then showing live hit-rate stats for both
  caches and the thread-pool configuration, auto-refreshing every 5
  seconds.

---

## API

The full HTTP API - `/probe`, `/probe/stream`, `/health`,
`/admin/cache/stats`, `/admin/cache/clear`, `/admin/login`,
`/admin/logout` - is documented as an OpenAPI 3.0 specification served
live by the running app at:

```
http://127.0.0.1:7860/openapi.yaml
```

`openapi.yaml` documents every endpoint's request/response shapes; the
ranking algorithm behind `moves_dtz` / `moves_dtc` / `moves_dtm` /
`moves_dtm50` is documented inline in `app.py`'s own module docstring and
its `evaluate_all_moves()` function. `/admin/cache/*` require an
`Authorization: Bearer <ADMIN_TOKEN>` header or an authenticated session
cookie from `/admin/login` - see [Security notes](#security-notes).

Quick example:

```bash
curl -X POST http://127.0.0.1:7860/probe \
     -H "Content-Type: application/json" \
     -d '{"fen": "4k3/8/8/8/8/8/8/4K2R w - - 0 1"}'
```

`variant` is optional and defaults to `"standard"` when omitted. It is
never inferred from the FEN itself - the orthodox starting array is
itself a legal Chess960 starting position, so the same FEN text is
ambiguous without it:

```bash
curl -X POST http://127.0.0.1:7860/probe \
     -H "Content-Type: application/json" \
     -d '{"fen": "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "variant": "chess960"}'
```

---

## Project structure

```
.
├── LICENSE                 # GPL-3.0-or-later license text for this project
├── THIRD_PARTY_LICENSES.md # Licenses and attributions for bundled third-party code, fonts, and the piece set
├── Dockerfile               # Container build used for Render (and any other Docker host)
├── render.yaml              # Render Blueprint: service definition, health check, env vars
├── app.py                  # Flask backend: routes, probing, caching
├── config.py               # All configuration, as plain Python values - see "Configuration reference"
├── openapi.yaml            # OpenAPI 3.0 specification, served at /openapi.yaml
├── requirements.txt
├── README.md
├── .gitattributes, .gitignore, .dockerignore
├── tablebase_router.py     # Routes each probe by piece count and castling rights across TABLEBASE_PATH/TABLEBASE_PATH_7_8/TABLEBASE_PATH_CASTLING
├── tablebase_opening.py    # Per-material table-opening lock policy, shared by tablebase_router.py and both remote backends
├── dtz_anchor.py           # Resolves rounded DTZ values by cross-checking the moves of a position
├── remote/
│   ├── remote_source.py     # Generic HTTP byte-range client shared by both remote backends - see its own module docstring
│   ├── remote_direct.py     # REMOTE_MODE="direct": probe remote tables in place over byte ranges - see its own module docstring
│   └── remote_fallback.py   # REMOTE_MODE="download": whole-file download, cached to local disk on first touch - see its own module docstring
├── templates/
│   ├── index.html          # Main explorer UI - mounts the React app (see frontend/)
│   └── admin.html          # Cache dashboard
├── frontend/                # React app for the explorer page - see "Frontend build"
│   ├── package.json, package-lock.json
│   ├── vite.config.js       # Builds into ../static/dist with fixed filenames (no cache-busting hash)
│   ├── index.html, admin.html  # Build entries (script and stylesheet)
│   └── src/
│       ├── main.jsx, App.jsx
│       ├── engine/          # Position/rules engine and tablebase client (chessops + Chessground)
│       ├── vendor/          # Vendored Chessground (script and base stylesheet) + chessops, bundled by the build
│       ├── hooks/useExplorer.js  # FEN box, PGN, auto-play, settings, keyboard shortcuts
│       ├── components/      # Board, results table, PGN panel, dialogs, settings panel
│       │   └── ui/          # Icon, Button, Segmented, Panel
│       ├── styles/          # Tokens, base, layout, component and chess stylesheets - see "Styling"
│       └── assets/fonts/    # Inter and JetBrains Mono (woff2)
└── static/
    ├── dist/                # Built frontend (see "Frontend build"): app.js, app.css, admin.css, fonts/
    ├── css/
    │   └── pieces-cburnett.css   # Piece-set stylesheet linked by templates/index.html
    ├── js/
    │   └── admin.js          # Admin dashboard client
    └── pieces/cburnett/     # Piece-set SVGs
```

---

## Security notes

- The `/probe` and `/probe/stream` endpoints are intentionally
  unauthenticated - evaluating a chess position is this app's public,
  core functionality. `/admin` and `/admin/cache/*` are gated behind
  `ADMIN_TOKEN` (see below); every other route requires no credential.
- **Rate limiting** on `/probe` and `/probe/stream` is controlled by
  `PROBE_RATE_LIMIT`, and on `/admin/login` separately by
  `ADMIN_LOGIN_RATE_LIMIT` (both in `config.py`'s "Rate limiting"
  section), each applied per client IP via
  [flask-limiter](https://flask-limiter.readthedocs.io/). A client over
  either limit gets a `429` with a JSON error body. `PROBE_RATE_LIMIT`'s
  default, `"60 per minute"`, covers normal browsing and
  autoplay at its default delay - raise it if legitimate autoplay at a
  fast delay setting gets throttled, lower it if the deployment sees
  abuse, or set either limit to `""` to disable it entirely.
  `ADMIN_LOGIN_RATE_LIMIT` defaults to `"5 per minute"`, tight enough to
  slow down repeated `ADMIN_TOKEN` guesses. Both limiters key on
  `request.remote_addr` as corrected by `TRUSTED_PROXY_COUNT` (see
  below) and their state lives in-process (`memory://`), which is
  sufficient for a single-container deployment (e.g. one Render Web
  Service instance) but isn't shared across multiple replicas.
- **`TRUSTED_PROXY_COUNT`** (`config.py`'s "Rate limiting" section) is
  what `request.remote_addr`, and therefore both rate limiters above,
  is corrected against, so it reads the real client IP from
  `X-Forwarded-For` rather than the address of the reverse proxy
  in front of this app. The same setting also governs whether
  `X-Forwarded-Proto` is trusted, correcting `request.scheme` /
  `request.is_secure` (and any externally-generated URL) when TLS
  terminates at that reverse proxy rather than at this app itself. In
  production (`DEBUG = False`) this configures [waitress's own `trusted_proxy_count`](https://docs.pylonsproject.org/projects/waitress/en/stable/proxy-headers.html):
  waitress parses both headers and corrects `REMOTE_ADDR`/`wsgi.url_scheme`
  itself, before Flask ever sees the request, so it takes priority here.
  [Werkzeug's `ProxyFix`](https://werkzeug.palletsprojects.com/en/latest/middleware/proxy_fix/)
  makes the equivalent correction for the `DEBUG = True` Flask-dev-server
  path, which doesn't run under waitress at all. Defaults to `1`,
  matching this project's own `render.yaml` topology; set it to match
  the deployment if that differs, or to `0` for a deployment with no
  reverse proxy in front of it at all.
- **Admin access** is controlled by `ADMIN_TOKEN` (`config.py`'s "Admin"
  section), read from the environment rather than hardcoded - set it as
  a platform secret (e.g. a Render environment variable, generated
  automatically by `render.yaml`'s `generateValue: true`) rather than
  committing it. Visiting `/admin` with no active session shows a login
  form; a correct token there starts a signed, `HttpOnly`,
  `SameSite=Lax` session cookie (`Secure` too, where configured - see
  `SESSION_COOKIE_SECURE` below). API clients can instead send
  `Authorization: Bearer <ADMIN_TOKEN>` directly, no session needed.
  Token comparison uses `hmac.compare_digest` (constant-time, resistant
  to timing attacks). Leaving `ADMIN_TOKEN` unset does **not** open the
  admin panel to everyone - every admin route responds `503` instead.
- **`SESSION_COOKIE_SECURE`** (`config.py`'s "Admin" section) controls
  whether the admin session cookie above requires HTTPS, independently
  of `DEBUG` - `DEBUG` is a development/runtime behavior switch, not a
  reliable indicator of the deployment's transport security, so
  `DEBUG = False` alone does not imply HTTPS is in front of this
  app. Read from a `SESSION_COOKIE_SECURE` env var (`"true"` or anything
  else, case-insensitive), defaulting `False` to match this project's own
  plain-HTTP local installation - a browser won't send a
  `Secure` cookie back over a plain HTTP connection, so `/admin/login`
  would otherwise appear to succeed while every subsequent authenticated
  `/admin/*` request came back `401`. Set to `"true"` for any deployment
  the browser reaches over HTTPS (including behind a TLS-terminating
  reverse proxy - the browser's own connection is what the `Secure`
  attribute governs, not the internal hop between the proxy and this
  process); `render.yaml` already sets this explicitly for the Render
  deployment it configures, since Render always terminates TLS at its
  edge.
- The app serves via **waitress**, a production-grade WSGI server, by
  default (`DEBUG = False` in `config.py`) - see [Running in production](#running-in-production).
  Only set `DEBUG = True` (which switches to Flask's own dev server) for
  local development, never for anything reachable from another machine.
- A `Content-Security-Policy` is set on every response: scripts and fonts
  are restricted to `'self'` (no inline scripts, no third-party sources);
  styles allow `'self'` plus `'unsafe-inline'` (needed for inline
  `style` attributes set by the React app and in `admin.html`); images
  allow `'self'` plus `data:`; `connect-src`/`default-src` are `'self'`
  too, so `fetch`/SSE calls can only reach this same origin. `object-src`,
  `base-uri`, and `form-action` are locked to `'none'`/`'self'`/`'self'`,
  and `frame-ancestors 'none'` is the CSP-native counterpart to the
  `X-Frame-Options: DENY` set alongside it. `X-Content-Type-Options:
  nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` are set
  too. Request bodies are capped at 4 KB.
- `config.py` itself holds no secrets - `ADMIN_TOKEN` and
  `FLASK_SECRET_KEY` are the only two secrets, and they are read only from
  the environment so the file stays safe to commit as-is. Every other
  setting is a non-sensitive value.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every probe returns "Position not covered by the loaded tablebase." | `TABLEBASE_PATH` is unset or wrong, or the position's piece count or castling right isn't covered by the currently configured tier - 7-8 piece positions need `TABLEBASE_PATH_7_8`, castling-rights positions need `TABLEBASE_PATH_CASTLING` (see [Configuration reference](#configuration-reference)). Check the startup log for "TABLEBASE_PATH opened at: ..." (or "opened remotely at: ...") or a warning. |
| A FEN is rejected with "Invalid castling availability" | The submitted castling-availability field is something other than `-` or a combination of `K`, `Q`, `k`, `q` (or, in Chess960 Mode, rook-file letters `a`-`h`/`A`-`H`), or names a castling right without a matching king and rook on the board. |
| A FEN with `a`-`h`/`A`-`H` castling-rights letters is rejected even though the position looks fine | Those letters are only accepted with **Chess960 Mode** on (settings panel, or `variant: "chess960"` on the API) - Standard mode only accepts `K`, `Q`, `k`, `q`, matching Standard chess's fixed castling-rook squares. |
| Dragging a king onto its own rook doesn't castle | **Chess960 Mode** is off - enable it in the settings panel (or send `variant: "chess960"` on the API) for Chess960-style king-onto-rook castling; in Standard mode a king can only reach its rook's square by regular king movement. |
| `/health` returns `503 degraded` | The tablebase failed to open - check `TABLEBASE_PATH` and file permissions. |
| `ModuleNotFoundError: No module named 'chess.chesstb'` | Plain PyPI `chess` was installed instead of the fork. Re-run `pip install -r requirements.txt` and confirm it pulled `chess` from `noobpwnftw/python-chess` (the `add-chesstb-tablebases` branch) rather than plain PyPI `chess` - see the note at the top of `requirements.txt`. |
| `ModuleNotFoundError: No module named 'config'` | `config.py` is missing from alongside `app.py`. It ships with the repository - if it was deleted or moved, restore it from the repo (or re-clone) and re-apply any edits, such as `TABLEBASE_PATH`. |
| App logs `Configuration error: ...` and exits immediately | A value in `config.py` is the wrong type or out of range for that setting (e.g. a string where an integer is expected, or a negative cache size) - the error message names which setting and why. Fix it in `config.py` and re-run `python app.py`. |
| Admin dashboard panels stuck on "Loading…" | Check the browser console for a CSP violation and verify that the app is running and reachable at the `/admin` URL. |
| A drag, drop, or spare-piece placement on the board is silently rejected | The board is Locked - the padlock button beside the FEN box is highlighted gold. Lock restricts board interaction to legal moves and disables the spare-piece trays and off-board drops; click the padlock again to unlock and edit freely. |
| Probing feels slow on positions with many legal moves, or doesn't scale with `PROBE_THREADS` | Confirm `lz4` is installed (`pip show lz4`, or `python -c "import lz4"`) - without it, `chess.chesstb`'s block decompression runs in pure Python and holds the GIL, so `PROBE_THREADS` can't achieve real parallelism. `pip install lz4` (already in `requirements.txt`) and restart. Otherwise, tune `PROBE_THREADS`, `PROBE_PARALLEL_THRESHOLD`, and `PROBE_TIMEOUT_SECS` in `config.py`. Note that `tablebase_router.py` guards each material's first open with a lock keyed by `(kind, material)`, so two threads racing to open the *same* never-before-seen material collapse onto one read, while distinct materials of the same kind open concurrently. If any configured tier uses `REMOTE_MODE="download"`, opens fall back to one lock shared per kind, so several distinct never-before-seen materials of that kind then open one at a time instead - either way, this only affects the very first probe against any given material. |
| `ModuleNotFoundError: No module named 'waitress'` | The active environment's dependencies are out of date - re-run `pip install -r requirements.txt` to pick up `waitress`. `app.py` imports it unconditionally at the top of the file, before `config.DEBUG` is even read, so setting `DEBUG = True` does **not** avoid this - waitress has to be installed either way. |
| Every probe on a remote `TABLEBASE_PATH` returns "Position not covered..." or `/health` is `degraded` | Confirm the URL is reachable and correct (try opening `TABLEBASE_PATH/wdl/KQK.lzw` - or any small material's `.lzw` - directly in a browser). Check the startup log's "TABLEBASE_PATH opened remotely at: ..." line (or a warning in its place) for the actual failure. |
| A probe occasionally returns `503` with `error_code: "probe_timeout"` | Another concurrent request was already probing the same position and didn't finish within `PROBE_TIMEOUT_SECS`. This is transient and retryable - the original probe has usually landed in the child-probe cache before a retry, so the retry is inexpensive. Frequent occurrences suggest raising `PROBE_TIMEOUT_SECS`, or that a slow remote `TABLEBASE_PATH` is the underlying bottleneck. |
| Remote probing feels slow, or repeated probes against the same material keep hitting the network | Check `REMOTE_TIMEOUT_SECS`/`REMOTE_MAX_RETRIES` aren't causing retries on a slow link, and consider raising `REMOTE_PAGE_CACHE_BYTES` - a too-small budget evicts cached pages (`"direct"`) or downloaded files (`"download"`) before later probes can reuse them. `GET /admin/cache/stats` surfaces this per tier as `tablebase_cache.<low|high|castling>.remote_page_cache` or `.remote_disk_cache` respectively. On a high-latency link also try raising `REMOTE_PAGE_SIZE_BYTES`, or `REMOTE_MODE = "download"`. See [Configuration reference](#configuration-reference). |
| On Render, the deploy never goes live / stays stuck "deploying" | Render's health check (`healthCheckPath: /health` in `render.yaml`, or the equivalent field on a manually-created service - see [Deploying to Render](#deploying-to-render)) only passes once `/health` returns `200`, which itself requires at least one of `TABLEBASE_PATH`, `TABLEBASE_PATH_7_8`, or `TABLEBASE_PATH_CASTLING` to have opened successfully. Check the service's **Logs** tab for the same "opened remotely at: ..." / warning line described above. |
| On Render, the service responds but the page never loads / connection refused | Typically a `PORT` mismatch. Confirm `config.py` reads `PORT` from the environment (see [Configuration reference](#configuration-reference)) and that nothing else in a custom start command overrides `HOST`/`PORT`. |

---

## Credits

- Tablebase data & format: [ChessTB / chessdb.cn](https://www.chessdb.cn/)
- Tablebase probing support: [noobpwnftw/python-chess (`add-chesstb-tablebases` branch)](https://github.com/noobpwnftw/python-chess/tree/add-chesstb-tablebases), a fork of [niklasf/python-chess](https://github.com/niklasf/python-chess)
- Remote (URL) tablebase support for the fork's `chess.chesstb` module - see `remote/remote_source.py`, `remote/remote_direct.py` and `remote/remote_fallback.py`
- Board UI: [Chessground](https://github.com/lichess-org/chessground)
- Move generation/validation on the client, for both Standard chess and
  Chess960: [chessops](https://github.com/niklasf/chessops)
- Production WSGI server: [waitress](https://docs.pylonsproject.org/projects/waitress/)
- Piece set: [cburnett](https://github.com/lichess-org/lila/blob/master/COPYING.md), a commonly-used community set found in most web chess UIs.

## License

ChessTB Explorer is licensed under `GPL-3.0-or-later`; see [`LICENSE`](LICENSE).
Bundled third-party components and their licenses are listed in
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
