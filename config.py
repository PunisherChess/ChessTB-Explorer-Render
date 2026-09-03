"""
config.py — ChessTB Explorer configuration

Edit the values below directly, then run `python app.py` — this file
*is* the configuration for almost everything. A handful of settings are
also readable from the process environment, each falling back to the
literal value below when that variable isn't set, so a single committed
copy of this file still behaves correctly across different hosting
platforms without editing it per-deployment:

  - ADMIN_TOKEN / FLASK_SECRET_KEY — always from the environment only
    (no literal fallback below) so they can be set as platform secrets
    (e.g. a Render "Environment Variable" marked secret, or a Hugging
    Face Space "Secret") without ever committing them — see the "Admin"
    section below.
  - PORT — read from the environment with a literal fallback, because
    platforms like Render assign the port dynamically per-deployment
    (via their own PORT variable) rather than letting you pick a fixed
    one — see the "Server" section below.
  - TABLEBASE_PATH / TABLEBASE_PATH_7_8 / TABLEBASE_PATH_CASTLING /
    GITHUB_URL — read from the environment with a literal fallback,
    purely for convenience: an env var lets you point a given deployment
    (e.g. a Render Web Service's dashboard) at a different tablebase
    location or repo URL without a commit, but editing the literal value
    below works exactly as well if you'd rather keep it all in one file.

Invalid values (wrong type, out of range) make the app log an error and
exit at startup rather than run with a silently-wrong configuration —
see AppConfig.from_config() in app.py.
"""

import os

# ── Tablebase location ──────────────────────────────────────────────────────

# ChessTB tables are split three ways: TABLEBASE_PATH covers positions
# with 6 or fewer men on the board, TABLEBASE_PATH_7_8 covers 7 and 8,
# and TABLEBASE_PATH_CASTLING covers positions where a king or rook still
# has a usable castling right, independently of piece count (chess.chesstb
# names that table differently and never resolves such a position from
# either of the other two, however many men are on the board). Every
# probe is routed by inspecting the exact position being probed — a root
# position and a child position one of its moves leads to (one piece
# fewer after a capture, or with a castling right given up) can resolve
# through a different path within the same request. See
# tablebase_router.py's module docstring for the full design.
#
# Each of the three settings accepts:
#   - a local directory path         TABLEBASE_PATH = r"C:\chesstb\6men"
#                                     TABLEBASE_PATH = "/data/chesstb/6men"
#   - an http(s):// base URL         TABLEBASE_PATH = "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve/6men"
#                                     (the trailing /resolve/<rev> is required — see README.md)
#   - a list mixing the two, tried left-to-right until one has the
#     material being probed — a "hybrid" source, typically a local mirror
#     of your most-probed materials backed by a remote URL for the rest:
#       TABLEBASE_PATH = ["/data/chesstb/6men", "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve/6men"]
#     (the environment-variable override below only ever supplies a
#     single path — a hybrid list can only be set here, as a literal.)
#
# Only TABLEBASE_PATH is required. TABLEBASE_PATH_7_8 left empty routes
# every non-castling position — 7 and 8 men included — through
# TABLEBASE_PATH, matching a single combined directory or URL that
# already covers up to 8 men. TABLEBASE_PATH_CASTLING left empty routes a
# still-usable-castling-right position through TABLEBASE_PATH the same
# way, rather than reporting it as not covered — most deployments never
# need either override, since 7-8 man tables run into the terabytes and
# castling rights are vanishingly rare in sub-9-man endgames.
#
# Left empty too, the app still starts, but every /probe request will
# fail and /health will report "degraded" until TABLEBASE_PATH is set.
#
# All three are also readable from an environment variable of the same
# name (falling back to the literal value below when unset) — handy on a
# platform like Render, where setting one from the service's
# dashboard/render.yaml means switching tablebase locations doesn't
# require a commit. A tablebase set this large (the full ChessTB set runs
# into the terabytes) is virtually always the remote/URL form in a PaaS
# deployment: attaching that much persistent disk to a single web service
# is both impractical and, at a platform's normal per-GB disk pricing,
# far more expensive than serving it remotely and probing with
# REMOTE_MODE = "direct" below, which stores nothing on disk at all.
TABLEBASE_PATH          = os.environ.get("TABLEBASE_PATH", "")
TABLEBASE_PATH_7_8      = os.environ.get("TABLEBASE_PATH_7_8", "")
TABLEBASE_PATH_CASTLING = os.environ.get("TABLEBASE_PATH_CASTLING", "")

# ── Server ───────────────────────────────────────────────────────────────────

# Set to True to run the app via Flask's own dev server (auto-reload,
# detailed error pages, interactive debugger) instead of waitress. Leave
# False for any deployment reachable from other machines — False is what
# makes `python app.py` serve via waitress, the production WSGI server
# this app ships with.
DEBUG = False

# Interface the server (waitress, or the Flask dev server if DEBUG is
# True) binds to. Set to "0.0.0.0" so the server accepts connections
# arriving at the container's network interface, as required by Render,
# Hugging Face Spaces, and any other containerized deployment. Use
# "127.0.0.1" instead only for single-machine local use with no other
# access control in front of it — see README.md's "Security notes".
HOST = "0.0.0.0"

# Port the server listens on — applies whether app.py ends up serving via
# waitress (DEBUG=False) or the Flask dev server (DEBUG=True).
#
# Read from a PORT environment variable first, falling back to 7860
# (Hugging Face Docker Spaces' default routed port) when unset. This
# matters specifically for Render: a Render web service is assigned its
# externally-routed port at deploy time via its own PORT variable
# (commonly 10000, but not guaranteed) rather than a fixed number you
# pick — the container is expected to read it and bind there, which is
# exactly what this does. Nothing to configure for a Render deployment:
# Render sets PORT itself and this picks it up automatically. Running
# locally with no PORT set falls back to 7860 as before.
PORT = int(os.environ.get("PORT", 7860))

# Number of worker threads waitress uses to handle concurrent requests
# (only relevant when DEBUG=False). Needs to be more than 1 so that a
# long-lived /probe/stream SSE connection can't block every other request
# — see README.md's "Running in production" section. This is separate
# from PROBE_THREADS below, which sizes the pool used internally to
# parallelise tablebase probing, not to serve HTTP requests.
WAITRESS_THREADS = 4

# ── Probing ──────────────────────────────────────────────────────────────────

# Worker threads in the probe thread pool used to evaluate a position's
# legal moves in parallel. Set to match a 2-vCPU host (e.g. Hugging
# Face's cpu-basic tier); raise it on a larger host, or leave as None to
# scale automatically instead (min(16, cpu_count() * 2)).
PROBE_THREADS = 2

# Minimum number of not-yet-cached child positions before a probe batch
# switches from sequential to the PROBE_THREADS thread pool. Lower this
# (or set to 1, to always parallelize) if you're probing positions with
# unusually many legal moves, or if profiling shows sequential probing is
# your bottleneck on your hardware; raise it if thread hand-off overhead
# outweighs the benefit for the kinds of positions you probe most.
PROBE_PARALLEL_THRESHOLD = 4

# Wall-clock timeout, in seconds, for a batch of parallel child probes
# (both in evaluate_all_moves()'s Phase 2 and /probe/stream's pre-warm
# loop) before the remaining probes are logged as timed-out and treated
# as unknown rather than blocking the request indefinitely.
PROBE_TIMEOUT_SECS = 30

# ── Caching ──────────────────────────────────────────────────────────────────

# Max entries in the root-FEN result cache (full JSON responses served by
# evaluate_fen()). Raising this keeps more distinct root positions warm
# across a session at the cost of memory.
EVALUATE_CACHE_SIZE = 4096

# Max entries in the child-position probe cache (raw WDL/DTZ/DTC/DTM/DTM50
# tuples served by _probe_fen()), shared between root probes and every
# child position probed while ranking moves.
PROBE_CACHE_SIZE = 16384

# Size (in bytes) of chess.chesstb's own internal cache of decoded/
# decompressed tablebase blocks, shared across the WDL/DTZ/DTC/DTM/DTM50
# tables.
# 64 MiB is chess.chesstb's own default. Raising this reduces repeated
# disk reads + decompression across a session at the cost of RAM — worth
# raising on a machine with RAM to spare, especially when running probes
# serially (PROBE_PARALLEL_THRESHOLD set high) with no thread pool to
# amortize that cost across.
BLOCK_CACHE_BYTES = 64 * 1024 * 1024

# ── Remote (URL) tablebase entries only ─────────────────────────────────────
# Everything below is ignored for a local-directory entry; it applies to
# every http(s):// entry across TABLEBASE_PATH, TABLEBASE_PATH_7_8, and
# TABLEBASE_PATH_CASTLING (including entries inside a hybrid list — see
# above). See remote/remote_fallback.py's module docstring for the full
# design.

# How a remote table's bytes reach the prober:
#
#   "direct"   -- probe the remote tables in place, fetching only the
#                 page-sized byte ranges each probe reads, nothing written
#                 to disk (remote/remote_direct.py). Needs a chess.chesstb
#                 new enough to have the table-source seam; if yours
#                 doesn't, the app logs that and uses "download" instead.
#   "download" -- fetch each table file in full on first touch and cache it
#                 on local disk (remote/remote_fallback.py). Slower first
#                 touch of a material and real disk usage, but every read
#                 after it is a local mmap read.
#
# "direct" is the better default for browsing across many materials, which
# is what this app does. Prefer "download" if you hammer a handful of
# materials for a long session, or if your network's per-request latency is
# high enough that many small requests hurt (one cold probe can issue
# several, since a probe of a dropped-frame table walks its children).
#
# "direct" is also the right choice for a PaaS deployment (e.g. Render)
# fronting a multi-terabyte tablebase set: it needs no persistent disk at
# all, so it sidesteps both the platform's per-GB disk cost at that scale
# and the fact that most platforms' single-service disks aren't sized for
# terabytes in the first place. "download" would need a disk (or enough
# ephemeral local storage) big enough for whichever materials get probed
# in a session, which — for a multi-GB material or a busy multi-user demo
# — can add up fast on an ephemeral container filesystem.
REMOTE_MODE = "direct"

# Soft budget, in bytes, shared across every remote table opened this
# session: bounds the in-memory page cache in "direct" mode, and the
# on-disk cache of whole downloaded table files in "download" mode.
REMOTE_PAGE_CACHE_BYTES = 128 * 1024 * 1024

# Size, in bytes, of one page. In "direct" mode this is the granularity of
# every fetch, so it sets the trade between over-fetching (too large) and
# many round trips per probe (too small) -- 256 KiB keeps a table's whole
# header + index region within a page or two, which is what makes later
# probes of the same table cheap. In "download" mode it is only the chunk
# size used while streaming a full file down, and has no effect on which
# bytes end up fetched.
REMOTE_PAGE_SIZE_BYTES = 256 * 1024

# Per-HTTP-request timeout, in seconds, for both existence/size checks and
# the download itself against a remote tablebase.
REMOTE_TIMEOUT_SECS = 20.0

# Number of attempts for a single remote request before giving up (the
# request that triggered it then fails, surfacing as a probe error).
REMOTE_MAX_RETRIES = 3

# Max size of the HTTP connection pool each remote backend's session
# keeps open against its entry's host. Left as None so it scales
# with PROBE_THREADS automatically (max(PROBE_THREADS * 2, 20)) — set an
# explicit integer to override. Too small a pool under-serves concurrent
# probing (connections stop being reused once PROBE_THREADS exceeds it);
# too large rarely hurts beyond a handful of idle sockets, so there's
# little reason to set this below the auto-computed value.
REMOTE_POOL_MAXSIZE = None

# ── Rate limiting ────────────────────────────────────────────────────────────

# Per-client-IP request limit applied to /probe and /probe/stream — the
# two public, unauthenticated, CPU-bound endpoints — using flask-limiter's
# string syntax (e.g. "60 per minute", "10 per second"; multiple limits
# can be combined with ";"). Backed by an in-process memory store, which
# is enough for a single-container deployment (e.g. one Render Web
# Service instance) but does not share state across multiple replicas.
# Left empty, rate limiting is disabled entirely.
#
# 60 per minute comfortably covers normal browsing and autoplay at its
# default 1.25s delay; raise it if legitimate autoplay at a fast delay
# setting gets throttled, or lower it if the deployment sees abuse.
PROBE_RATE_LIMIT = "60 per minute"

# ── Admin ────────────────────────────────────────────────────────────────────

# Shared secret required to reach /admin, /admin/cache/stats, and
# /admin/cache/clear. Read from the ADMIN_TOKEN environment variable
# rather than hardcoded here — set it as a platform secret (e.g. a
# Render "Environment Variable" marked secret, generated automatically by
# render.yaml's generateValue: true) rather than committing it here.
# Left unset, every admin route responds 503 rather than running without
# a password. Visiting /admin with no active session shows a login form;
# a correct token there starts a signed session cookie. API clients may
# instead send "Authorization: Bearer <ADMIN_TOKEN>" directly.
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

# Key Flask uses to sign the admin session cookie. Read from the
# FLASK_SECRET_KEY environment variable for the same reason as
# ADMIN_TOKEN above. Left unset, a random key is generated at process
# startup instead — sessions still work, but every restart invalidates
# existing ones, requiring the admin to log in again. Set an explicit,
# persistent value if that's undesirable (e.g. behind a load balancer
# with multiple replicas, or to survive routine restarts).
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "")

# ── Links ────────────────────────────────────────────────────────────────────

# Repository URL for the GitHub button shown in the header of every page.
# Left empty, the button is omitted entirely. Also readable from a
# GITHUB_URL environment variable (falling back to the literal string
# below when unset), so a platform deployment can set it from its own
# dashboard without a commit — see render.yaml.
GITHUB_URL = os.environ.get("GITHUB_URL", "")
