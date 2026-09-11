"""
app.py — ChessTB Explorer back-end

A single-file Flask application that probes a ChessTB endgame tablebase
for a submitted FEN position and returns every legal move ranked by
Distance to Zeroing (DTZ), Distance to Conversion (DTC), Distance to
Mate (DTM), and DTM under the 50-move rule (DTM50).

DTC is 50-move-rule-aware in the same way DTM50 is (it is always probed
at the position's own halfmove clock), but unlike DTM50 it has no
"flat"/clock-independent sibling column of its own -- there is only ever
one DTC value for a position. A ``.lzdtc`` table only exists for material
with at least one pawn; for pawnless material `chess.chesstb` derives an
equivalent answer from DTZ/WDL instead (see chess.chesstb.ProbeResult
below), so `has_dtc` is False only when a pawnful material's own
`.lzdtc` file genuinely hasn't been generated/shipped.

Routes
------
  POST /probe              — evaluate a FEN position (JSON)
  POST /probe/stream       — evaluate with SSE streaming progress
  GET  /                   — main UI
  GET  /health             — readiness check
  GET  /admin              — cache dashboard HTML page, or a login form if not authenticated
  POST /admin/login        — start an admin session (JSON {token})
  POST /admin/logout       — end the admin session
  POST /admin/cache/clear  — purge both LRU caches
  GET  /admin/cache/stats  — cache hit-rate statistics
  GET  /openapi.yaml       — OpenAPI 3.0 specification

/admin and /admin/cache/* require admin authentication -- either a
session cookie started via /admin/login, or an "Authorization: Bearer
<ADMIN_TOKEN>" header. See config.py's "Admin" section and README.md's
"Security notes" for how ADMIN_TOKEN is configured.

/probe and /probe/stream are rate-limited per client IP (config.py's
PROBE_RATE_LIMIT); a client over the limit gets a 429 with a JSON body.
/admin/login has its own, separate limit (config.py's
ADMIN_LOGIN_RATE_LIMIT), covering both failed and successful attempts.

Each move entry includes a child_fen so the client can pre-fetch the next
probe, and each response includes a summary of wins/draws/losses/unknown
across all legal moves. A position not covered by the loaded tablebase
raises MissingTableError, which is returned as structured JSON
({error_code, piece_count}). Root-JSON and child-probe cache sizes are
configurable via the EVALUATE_CACHE_SIZE / PROBE_CACHE_SIZE env vars.

Every request to /probe and /probe/stream carries an explicit "variant"
field ("standard" or "chess960", defaulting to "standard" when omitted)
alongside "fen" -- the two rulesets are never inferred from a FEN's
contents, since the orthodox starting arrangement is itself a legal
Chess960 starting position and would otherwise be ambiguous. A submitted
FEN's castling-availability field accepts "-" or any combination of "K",
"Q", "k", "q" for variant="standard", plus rook-file letters ("a"-"h" /
"A"-"H") for variant="chess960"; a right with no matching king/rook pair
is rejected as invalid input before the board is ever probed (see
_validate_and_build_board). A position with castling rights is otherwise
probed like any other: `chess.chesstb` resolves it when the loaded
tablebase set carries a table for that material (see config.py's
TABLEBASE_PATH_CASTLING and tablebase_router.py -- unaffected by variant,
since a Chess960 board's clean_castling_rights() reports the same way a
Standard board's does), and reports it as not covered when it doesn't.

Running this file directly (`python app.py`) serves the app via waitress
(a production-grade WSGI server) by default. Set DEBUG = True in
config.py to use Flask's own dev server instead (auto-reload +
interactive debugger) for local development. See README.md
"Installation" / "Running in production" for details.
"""

from __future__ import annotations

from concurrent.futures import (
    ThreadPoolExecutor,
    wait as futures_wait,
    ALL_COMPLETED,
    FIRST_COMPLETED,
)
from dataclasses import dataclass
from flask import (
    Flask, render_template, request, jsonify, Response,
    stream_with_context, send_file, session,
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from functools import lru_cache, wraps
from typing import TypedDict
from waitress import serve as waitress_serve
from werkzeug.middleware.proxy_fix import ProxyFix
import atexit
import chess
import config
import hmac
import importlib.util
import json
import os
import re
import logging
import secrets
import sys
import tablebase_router
import threading
import time

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)


# ── ChessTB backend ───────────────────────────────────────────────────────────

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REMOTE_FALLBACK_PATH = os.path.join(_THIS_DIR, "remote", "remote_fallback.py")
_REMOTE_DIRECT_PATH = os.path.join(_THIS_DIR, "remote", "remote_direct.py")


def _load_module_by_path(module_name: str, path: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# chess.chesstb comes from noobpwnftw's add-chesstb-tablebases fork of
# python-chess (see requirements.txt) — open_tablebase, ProbeResult's raw
# wdl/dtz/dtc/dtm/dtm50 fields, MissingTableError, and the WIN/CURSED_WIN/
# DRAW/BLESSED_LOSS/LOSE constants all come from that module.
import chess.chesstb as chesstb

log.info("chess.chesstb backend: noobpwnftw/python-chess (add-chesstb-tablebases)")

# Remote (HTTP) tablebase support, in two flavours -- config.REMOTE_MODE
# picks one, and both are signature-compatible with
# chesstb.open_tablebase so the choice is one call below:
#   remote/remote_direct.py   ("direct")   probe in place over byte ranges
#   remote/remote_fallback.py ("download") whole-file download, disk-cached
# See each file's module docstring for the design and the trade-off.
# looks_like_remote()/RemoteSourceError come from remote/remote_source.py,
# re-exported identically through both.
_remote_download = _load_module_by_path("_chesstb_remote_fallback", _REMOTE_FALLBACK_PATH)
_remote_direct = _load_module_by_path("_chesstb_remote_direct", _REMOTE_DIRECT_PATH)
remote_source = _remote_download.remote_source


# ── Type aliases ──────────────────────────────────────────────────────────────

class MoveEntry(TypedDict):
    san:         str
    plies:       int
    order:       int         # DTC only: pawn pushes still owed before a conversion (0 for every other metric)
    is_mate:     bool
    outcome:     str         # "win"|"cursed_win"|"draw"|"blessed_loss"|"loss"|"unknown"|"not_available"
    available:   bool        # False when this move's own metric table isn't present (outcome is then "not_available")
    child_fen:   str | None  # FEN after this move; None for terminal / unknown
    draw_reason: str | None  # "stalemate"|"insufficient_material"|None


MoveList = list[MoveEntry]


# ── Config validation helpers ─────────────────────────────────────────────────
# Centralise the "read a config.py value, check its type, validate range"
# pattern that AppConfig.from_config() below needs once per setting.

def _validated_int(name: str, value, *, min_val: int | None = 1, max_val: int | None = None) -> int:
    if isinstance(value, str):
        # PORT and TRUSTED_PROXY_COUNT are the two config.py settings read
        # as a raw string rather than pre-converted at import time (see
        # config.py's own comments on each) -- specifically so a bad
        # value raises here, inside AppConfig.from_config()'s try/except,
        # rather than as an uncaught ValueError from a bare int() call
        # during module import, before this module has an exception handler
        # in place for it.
        try:
            value = int(value.strip())
        except ValueError:
            raise ValueError(f"config.{name} must be an integer, got {value!r}") from None
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"config.{name} must be an integer, got {value!r}")
    if min_val is not None and max_val is not None and not (min_val <= value <= max_val):
        raise ValueError(f"config.{name} must be {min_val}-{max_val}, got {value}")
    if max_val is None and min_val is not None and value < min_val:
        raise ValueError(f"config.{name} must be >= {min_val}, got {value}")
    if min_val is None and max_val is not None and value > max_val:
        raise ValueError(f"config.{name} must be <= {max_val}, got {value}")
    return value


def _validated_float(name: str, value, *, min_val: float = 0) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"config.{name} must be a number, got {value!r}")
    value = float(value)
    if value <= min_val:
        raise ValueError(f"config.{name} must be > {min_val}, got {value}")
    return value


def _validated_str(name: str, value) -> str:
    if not isinstance(value, str):
        raise ValueError(f"config.{name} must be a string, got {value!r}")
    return value


def _validated_path_spec(name: str, value) -> str | list[str]:
    """TABLEBASE_PATH / TABLEBASE_PATH_7_8 / TABLEBASE_PATH_CASTLING: a
    single path (local directory or http(s):// URL) or a list of them for
    a hybrid source (see tablebase_router.py). Each list entry must
    itself be a string -- a nested list isn't a valid hybrid source."""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)) and all(isinstance(v, str) for v in value):
        return list(value)
    raise ValueError(f"config.{name} must be a string or a list of strings, got {value!r}")


def _validated_choice(name: str, value, allowed: tuple) -> str:
    if value not in allowed:
        raise ValueError(
            f"config.{name} must be one of {', '.join(map(repr, allowed))}, got {value!r}")
    return value


def _validated_bool(name: str, value) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"config.{name} must be True or False, got {value!r}")
    return value


# ── Validated configuration ───────────────────────────────────────────────────

@dataclass(frozen=True)
class AppConfig:
    tablebase_path:      str | list[str]
    probe_threads:       int
    parallel_threshold:  int
    probe_timeout:       float
    # <=6-men tablebase, same accepted forms as tablebase_path. Empty
    # routes every non-castling position -- 7 and 8 men included --
    # through tablebase_path (see tablebase_router.RoutedTablebase).
    tablebase_path_7_8:  str | list[str]
    # Castling-rights-aware tablebase, same accepted forms as
    # tablebase_path. Independent of piece count: a position with a
    # still-usable castling right routes here first, regardless of how
    # many men are on the board. Empty routes such a position through the
    # same piece-count selection as tablebase_path_7_8 above instead (see
    # tablebase_router.RoutedTablebase).
    tablebase_path_castling: str | list[str]
    host:                str
    port:                int
    evaluate_cache_size: int
    probe_cache_size:    int
    block_cache_bytes:   int
    debug:               bool
    waitress_threads:    int
    # Only used for an http(s):// URL entry in tablebase_path,
    # tablebase_path_7_8, or tablebase_path_castling (see "ChessTB
    # backend" above and remote/remote_source.py) -- ignored entirely for
    # a local-directory entry. Bounds an on-disk LRU of whole downloaded
    # table files cached by remote/remote_fallback.py (see that file's
    # module docstring for the full design).
    remote_mode:             str
    remote_page_cache_bytes: int
    remote_page_size_bytes:  int
    remote_timeout_secs:     float
    remote_max_retries:      int
    remote_pool_maxsize:     int
    admin_token:             str
    secret_key:              str
    github_url:              str
    probe_rate_limit:        str
    prefetch_rate_limit:     str
    admin_login_rate_limit:  str
    trusted_proxy_count:     int
    session_cookie_secure:   bool
    # Hard-coded limit, not one of config.py's settings -- kept as a
    # dataclass field (rather than a bare module constant) so it reads
    # alongside every other request-validation knob above.
    max_fen_length:      int   = 100

    @classmethod
    def from_config(cls) -> "AppConfig":
        # PROBE_THREADS is the one setting with a computed (not literal)
        # default, so a None left in config.py falls back to a
        # CPU-count-based figure instead of going through _validated_int.
        threads = (
            _validated_int("PROBE_THREADS", config.PROBE_THREADS)
            if config.PROBE_THREADS is not None
            else min(16, (os.cpu_count() or 4) * 2)
        )
        # Same "None means auto" shape as PROBE_THREADS above, computed
        # from it: a connection pool smaller than the probe thread count
        # gives up connection reuse for whichever requests land once the
        # pool is exhausted (see remote/remote_source.py).
        pool_maxsize = (
            _validated_int("REMOTE_POOL_MAXSIZE", config.REMOTE_POOL_MAXSIZE)
            if config.REMOTE_POOL_MAXSIZE is not None
            else max(threads * 2, 20)
        )

        return cls(
            tablebase_path=_validated_path_spec("TABLEBASE_PATH", config.TABLEBASE_PATH),
            probe_threads=threads,
            parallel_threshold=_validated_int("PROBE_PARALLEL_THRESHOLD", config.PROBE_PARALLEL_THRESHOLD),
            probe_timeout=_validated_float("PROBE_TIMEOUT_SECS", config.PROBE_TIMEOUT_SECS),
            tablebase_path_7_8=_validated_path_spec("TABLEBASE_PATH_7_8", config.TABLEBASE_PATH_7_8),
            tablebase_path_castling=_validated_path_spec(
                "TABLEBASE_PATH_CASTLING", config.TABLEBASE_PATH_CASTLING),
            host=_validated_str("HOST", config.HOST),
            port=_validated_int("PORT", config.PORT, max_val=65535),
            evaluate_cache_size=_validated_int("EVALUATE_CACHE_SIZE", config.EVALUATE_CACHE_SIZE),
            probe_cache_size=_validated_int("PROBE_CACHE_SIZE", config.PROBE_CACHE_SIZE),
            block_cache_bytes=_validated_int("BLOCK_CACHE_BYTES", config.BLOCK_CACHE_BYTES),
            # DEBUG also selects the server used by
            # `if __name__ == "__main__"` below: the Flask dev server when
            # True, waitress otherwise (see README.md "Running in production").
            debug=_validated_bool("DEBUG", config.DEBUG),
            waitress_threads=_validated_int("WAITRESS_THREADS", config.WAITRESS_THREADS),
            remote_mode=_validated_choice("REMOTE_MODE", config.REMOTE_MODE, ("direct", "download")),
            remote_page_cache_bytes=_validated_int(
                "REMOTE_PAGE_CACHE_BYTES", config.REMOTE_PAGE_CACHE_BYTES),
            remote_page_size_bytes=_validated_int(
                "REMOTE_PAGE_SIZE_BYTES", config.REMOTE_PAGE_SIZE_BYTES),
            remote_timeout_secs=_validated_float("REMOTE_TIMEOUT_SECS", config.REMOTE_TIMEOUT_SECS),
            remote_max_retries=_validated_int("REMOTE_MAX_RETRIES", config.REMOTE_MAX_RETRIES),
            remote_pool_maxsize=pool_maxsize,
            admin_token=_validated_str("ADMIN_TOKEN", config.ADMIN_TOKEN),
            secret_key=_validated_str("FLASK_SECRET_KEY", config.FLASK_SECRET_KEY),
            github_url=_validated_str("GITHUB_URL", config.GITHUB_URL),
            probe_rate_limit=_validated_str("PROBE_RATE_LIMIT", config.PROBE_RATE_LIMIT),
            prefetch_rate_limit=_validated_str("PREFETCH_RATE_LIMIT", config.PREFETCH_RATE_LIMIT),
            admin_login_rate_limit=_validated_str("ADMIN_LOGIN_RATE_LIMIT", config.ADMIN_LOGIN_RATE_LIMIT),
            trusted_proxy_count=_validated_int(
                "TRUSTED_PROXY_COUNT", config.TRUSTED_PROXY_COUNT, min_val=0, max_val=10),
            session_cookie_secure=_validated_bool("SESSION_COOKIE_SECURE", config.SESSION_COOKIE_SECURE),
        )


try:
    cfg = AppConfig.from_config()
except (ValueError, AttributeError) as e:
    log.error("Configuration error: %s — fix config.py and restart.", e)
    raise SystemExit(1) from e

# Exception type to treat as "couldn't reach the remote tablebase" in the
# /probe and /probe/stream handlers below.
_REMOTE_SOURCE_ERROR = remote_source.RemoteSourceError

if not cfg.tablebase_path:
    log.warning("TABLEBASE_PATH is not set — tablebase lookups will fail.")

if not cfg.admin_token:
    log.warning(
        "ADMIN_TOKEN is not set — /admin and /admin/cache/* will respond "
        "503 until it's configured (see config.py's \"Admin\" section)."
    )


# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024   # 4 KB

# secrets.token_hex(32) generated fresh at process startup when
# FLASK_SECRET_KEY isn't set (see config.py) -- every admin session is then
# invalidated by a restart, requiring a new login; it never
# breaks anything the app itself depends on, since sessions here hold
# nothing but the admin_ok flag set by /admin/login.
app.secret_key = cfg.secret_key or secrets.token_hex(32)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# Independent of cfg.debug -- see config.py's SESSION_COOKIE_SECURE for
# why: DEBUG is a development/runtime behavior switch, not a reliable
# indicator of whether the browser reaches this deployment over HTTPS.
app.config["SESSION_COOKIE_SECURE"] = cfg.session_cookie_secure

# Without this, request.remote_addr -- and therefore get_remote_address()
# below, which keys both rate limiters -- is whichever host made the TCP
# connection to this process. Behind a reverse proxy (Render's own
# edge/load-balancer in front of the render.yaml deployment this project
# ships with, or any other reverse proxy placed in front of it) that's the
# proxy's own address, not the actual client's, so every client sharing
# that proxy would collapse onto one rate-limit key. ProxyFix instead
# trusts exactly cfg.trusted_proxy_count X-Forwarded-For hops closest to
# this app and reads the real client IP from ahead of them -- set to 0
# this is a no-op, appropriate only for a deployment with no reverse proxy
# in front of it at all (an untrusted client's own X-Forwarded-For header
# would otherwise be trusted, letting it spoof its rate-limit key).
#
# x_proto does the equivalent correction for X-Forwarded-Proto, which a
# TLS-terminating reverse proxy sets to tell this app the scheme the
# client actually connected with -- without it, request.scheme /
# request.is_secure (and any URL this app builds with
# url_for(..., _external=True)) would read as plain http:// even when the
# client's own connection was https://, since Flask only ever sees the
# proxy's own (typically-HTTP) hop to this app. Same trusted-hop count as
# x_for, for the same reason: a value here that doesn't match the real
# proxy chain either misreads the scheme or lets a client spoof it.
#
# This only actually matters for cfg.debug's Flask-dev-server path below --
# under waitress (cfg.debug False, the production path), waitress parses
# X-Forwarded-For and corrects REMOTE_ADDR itself before this app ever
# sees the request, taking priority over -- and making redundant, but
# harmlessly so -- the correction this makes. See the waitress_serve(...)
# call below for that side of it.
if cfg.trusted_proxy_count > 0:
    app.wsgi_app = ProxyFix(
        app.wsgi_app, x_for=cfg.trusted_proxy_count, x_proto=cfg.trusted_proxy_count)


@app.errorhandler(413)
def request_too_large(e: Exception) -> tuple:
    return jsonify({"error": "Request body too large (max 4 KB)."}), 413


# ── Rate limiting ────────────────────────────────────────────────────────────
# Per-IP limits on /probe, /probe/stream (config.py's PROBE_RATE_LIMIT, or
# PREFETCH_RATE_LIMIT for a request tagged "X-Prefetch: 1" -- see
# _request_probe_limit below) and, separately, /admin/login (config.py's
# ADMIN_LOGIN_RATE_LIMIT -- see README.md's "Security notes").
# default_limits=[] means nothing is limited except the routes explicitly
# decorated with @_probe_rate_limit / @_admin_login_rate_limit below; the
# in-memory storage is per-process, which is enough for a single-container
# deployment but doesn't share state across multiple replicas. key_func
# reads request.remote_addr, which ProxyFix (see the Flask app section
# above) has already corrected for cfg.trusted_proxy_count reverse-proxy
# hops.
limiter = Limiter(
    key_func=get_remote_address, app=app, default_limits=[], storage_uri="memory://",
    headers_enabled=True)


def _request_probe_limit() -> str:
    # X-Prefetch is client-asserted and therefore untrusted as a basis for
    # *relaxing* enforcement -- it only ever selects a separate, tighter
    # budget than the default, never bypasses PROBE_RATE_LIMIT. A request
    # without the header, or when PREFETCH_RATE_LIMIT is unset, always
    # falls back to the normal probe budget.
    if request.headers.get("X-Prefetch") == "1" and cfg.prefetch_rate_limit:
        return cfg.prefetch_rate_limit
    return cfg.probe_rate_limit


def _probe_rate_limit(view):
    # A plain pass-through when neither limit is configured, rather than
    # a zero/near-zero limiter.limit() call, so "disabled" actually means
    # unlimited rather than "limited to approximately nothing." A
    # callable limit_value (rather than the plain string
    # _admin_login_rate_limit below uses) is what lets a single decorator
    # route a hover-prefetch request to its own, tighter budget -- see
    # _request_probe_limit above -- flask-limiter re-evaluates it on
    # every request rather than once at decoration time.
    if not cfg.probe_rate_limit and not cfg.prefetch_rate_limit:
        return view
    return limiter.limit(_request_probe_limit)(view)


def _admin_login_rate_limit(view):
    # Independent of _probe_rate_limit above -- /admin/login is a
    # brute-forceable shared-secret check, not a CPU-bound probe, so it
    # gets its own (much tighter) limit rather than reusing or being
    # covered by PROBE_RATE_LIMIT.
    if not cfg.admin_login_rate_limit:
        return view
    return limiter.limit(cfg.admin_login_rate_limit)(view)


@app.errorhandler(429)
def rate_limit_exceeded(e: Exception) -> tuple:
    return jsonify({
        "error": "Too many requests. Please slow down and try again shortly.",
    }), 429


# ── Tablebase + thread pool ───────────────────────────────────────────────────
# TABLEBASE_PATH (<=6 men), TABLEBASE_PATH_7_8 (7-8 men), and
# TABLEBASE_PATH_CASTLING (any castling-rights-bearing position,
# independent of piece count) are opened independently and combined into
# one RoutedTablebase, whose upstream-compatible lookup also serves
# recursive dependency probes. See tablebase_router.py for the routing rules.

def _open_tier(spec, label: str):
    """Opens one tier via tablebase_router.open_many(), converting any
    failure to None instead of letting it escape -- so a failure opening
    one tier (e.g. an unreachable optional TABLEBASE_PATH_7_8 /
    TABLEBASE_PATH_CASTLING source) can never discard a sibling tier
    that already opened successfully."""
    try:
        return tablebase_router.open_many(
            spec, label=label, cfg=cfg,
            remote_source=remote_source, remote_direct=_remote_direct,
            remote_download=_remote_download,
        )
    except Exception as e:
        log.warning("Failed to open %s: %s", label, e)
        return None


_tb_low = _open_tier(cfg.tablebase_path, "TABLEBASE_PATH")
_tb_high = _open_tier(cfg.tablebase_path_7_8, "TABLEBASE_PATH_7_8")
_tb_castling = _open_tier(cfg.tablebase_path_castling, "TABLEBASE_PATH_CASTLING")
TB = (
    tablebase_router.RoutedTablebase(
        low=_tb_low, high=_tb_high, castling=_tb_castling,
        remote_source=remote_source, block_cache_bytes=cfg.block_cache_bytes,
    )
    if (_tb_low or _tb_high or _tb_castling) else None
)

_executor = ThreadPoolExecutor(max_workers=cfg.probe_threads, thread_name_prefix="tb_probe")
log.info(
    "Thread pool: %d workers, parallel_threshold=%d, timeout=%.0fs, "
    "eval_cache=%d, probe_cache=%d, block_cache_bytes=%d",
    cfg.probe_threads, cfg.parallel_threshold, cfg.probe_timeout,
    cfg.evaluate_cache_size, cfg.probe_cache_size, cfg.block_cache_bytes,
)


@atexit.register
def _close_tb() -> None:
    try:
        if TB is not None:
            TB.close()
    except Exception as e:
        log.warning("Error closing tablebase: %s", e)


@atexit.register
def _shutdown_executor() -> None:
    try:
        _executor.shutdown(wait=True, cancel_futures=True)
    except Exception as e:
        log.warning("Error shutting down thread pool: %s", e)


# ── Security headers ──────────────────────────────────────────────────────────

@app.after_request
def set_security_headers(response: Response) -> Response:
    # base-uri and form-action are set explicitly since default-src doesn't
    # cover them; object-src, though covered, is set to 'none' since the app
    # has no use for <object>/<embed>. frame-ancestors 'none' is the CSP
    # equivalent of the X-Frame-Options: DENY header set below.
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; img-src 'self' data:; connect-src 'self'; "
        "object-src 'none'; base-uri 'self'; form-action 'self'; "
        "frame-ancestors 'none';"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# ── Admin authentication ────────────────────────────────────────────────────
# Gates /admin and /admin/cache/* behind cfg.admin_token (see config.py's
# "Admin" section). Two ways to authenticate:
#   - Browser: POST /admin/login with the token starts a signed session
#     cookie (see app.secret_key above); subsequent requests from the same
#     browser are authenticated via that cookie automatically.
#   - API client: send "Authorization: Bearer <ADMIN_TOKEN>" directly,
#     no session/cookie needed.
# If cfg.admin_token is empty, every admin route responds 503 rather than
# running with no password -- there is no "admin panel open to everyone"
# fallback.

def _admin_token_matches(candidate: str) -> bool:
    # hmac.compare_digest for constant-time comparison -- a plain `==`
    # would leak the token's length/prefix through response-timing
    # differences to an attacker making repeated guesses.
    return bool(cfg.admin_token) and hmac.compare_digest(candidate, cfg.admin_token)


def _is_admin_authenticated() -> bool:
    if session.get("admin_ok"):
        return True
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return _admin_token_matches(auth_header[len("Bearer "):])
    return False


def _require_admin(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not cfg.admin_token:
            return jsonify({
                "error": "Admin panel disabled: ADMIN_TOKEN is not configured.",
            }), 503
        if not _is_admin_authenticated():
            return jsonify({"error": "Admin authentication required."}), 401
        return view(*args, **kwargs)
    return wrapped


# ── FEN normalisation ─────────────────────────────────────────────────────────

_FEN_FIELD_DEFAULTS = ("8/8/8/8/8/8/8/8", "w", "-", "-", "0", "1")


def _normalize_fen(fen: str) -> str:
    parts = fen.split()
    while len(parts) < 6:
        parts.append(_FEN_FIELD_DEFAULTS[len(parts)])
    return " ".join(parts[:6])


# ── Sort helpers ──────────────────────────────────────────────────────────────

_OUTCOME_RANK: dict[int, int] = {2: 0, 1: 1, 0: 2, -1: 3, -2: 4}


def _outcome_rank(wdl_val: int) -> int:
    return _OUTCOME_RANK[wdl_val]


def _ply_rank(wdl_val: int, eff_val: int) -> int:
    if wdl_val > 0:  return eff_val
    if wdl_val < 0:  return -abs(eff_val)
    return 0


def _order_rank(wdl_val: int, order: int) -> int:
    """Sort key for DTC's "pushes still owed" component. DTC's own notion
    of a better line is pushes first, then plies (see ProbeResult's
    docstring in chess.chesstb): fewer pushes owed is better while
    winning, more is better while losing (it's more delay bought before
    the opponent's own clock forces a conversion). order is already an
    unsigned count, so — unlike _ply_rank — there's no magnitude to
    unwrap, only a direction to apply."""
    if wdl_val > 0:  return order
    if wdl_val < 0:  return -order
    return 0


_WDL_TO_OUTCOME_LABEL: dict[int, str] = {
    2: "win", 1: "cursed_win", 0: "draw", -1: "blessed_loss", -2: "loss",
}


def _outcome_label(wdl_val: int) -> str:
    return _WDL_TO_OUTCOME_LABEL[wdl_val]


def _effective_move_wdl(move_wdl: int, root_wdl: int, eff_distance: int) -> int:
    """The win/cursed-win (or loss/blessed-loss) bucket a move belongs in,
    used for both its outcome label and its sort-key rank. A raw win/loss
    (move_wdl 2/-2) downgrades to cursed_win/blessed_loss (1/-1) when its
    own eff_distance exceeds the 100-ply cutoff. The result is then capped
    at root_wdl, since a move can never be better than the root position's
    own optimal value — this cap is one-directional, as a move CAN be
    worse than root_wdl (e.g. a blunder turning a blessed_loss root into a
    pure -2 loss). Draws pass through unchanged."""
    if move_wdl == 2 and abs(eff_distance) > 100:
        move_wdl = 1
    elif move_wdl == -2 and abs(eff_distance) > 100:
        move_wdl = -1
    if move_wdl > root_wdl:
        move_wdl = root_wdl
    return move_wdl


def _effective_distance(wdl: int, raw_distance: int) -> int:
    if wdl != 0 and raw_distance == 0:
        return 1 if wdl > 0 else -1
    if raw_distance > 0:
        return raw_distance + 1
    if raw_distance < 0:
        return raw_distance - 1
    return 0


def _capped_wdl(move_wdl: int, root_wdl: int) -> int:
    """move_wdl capped at root_wdl: a move can never be better than the root
    position's own optimal value (see _effective_move_wdl). Used to bucket a
    move's outcome from WDL alone for the response's summary counts — WDL is
    the only metric every probeable move has, independent of which of
    DTZ/DTC/DTM/DTM50 this material's tables happen to cover."""
    return root_wdl if move_wdl > root_wdl else move_wdl


# ── Variant ────────────────────────────────────────────────────────────────
#
# "standard" | "chess960". Chess960 changes only the interpretation of
# castling rights/moves -- board geometry, piece movement, and tablebase
# material selection are unaffected (see tablebase_router.py, unchanged by
# variant). The two rulesets are never inferred from a FEN's contents: the
# orthodox starting array is itself one of the 960 legal Chess960 starting
# arrangements, so the same FEN text is genuinely ambiguous without this
# explicit field. An omitted variant defaults to "standard".
_ALLOWED_VARIANTS = frozenset({"standard", "chess960"})


def _normalize_variant(value: object) -> str:
    if value is None:
        return "standard"
    if not isinstance(value, str):
        raise ValueError("variant must be a string.")
    normalized = value.strip().lower()
    if normalized not in _ALLOWED_VARIANTS:
        raise ValueError("Unsupported variant: expected 'standard' or 'chess960'.")
    return normalized


def _build_board(variant: str, fen: str) -> chess.Board:
    """The single place a chess.Board is constructed from a request- or
    move-generation-supplied FEN string. chess960=True changes only how
    the fork parses/serializes the castling field and how it represents
    castling moves -- everything else about the resulting Board (piece
    movement, check/mate detection, piece_map, etc.) behaves identically
    to the variant="standard" path."""
    return chess.Board(fen, chess960=(variant == "chess960"))


# ── FEN pre-validation ────────────────────────────────────────────────────────

_EP_PATTERN = re.compile(r"^(-|[a-h][36])$")
_CASTLING_PATTERN_STANDARD = re.compile(r"^K?Q?k?q?$")
# Chess960 castling rights use conventional K/Q/k/q where applicable and
# rook-file letters for explicit rook identification. Semantic validity is
# checked after board construction.
_CASTLING_PATTERN_CHESS960 = re.compile(r"^[A-Ha-hKQkq]{1,4}$")


def _validate_fen_parts(variant: str, parts: list[str]) -> str | None:
    if len(parts) < 2:
        return "FEN must have at least a piece-placement field and a side-to-move field."
    if parts[1] not in ("w", "b"):
        return f"Invalid side to move: '{parts[1]}' (expected 'w' or 'b')."
    if len(parts) >= 3 and parts[2] != "-":
        if variant == "chess960":
            if not _CASTLING_PATTERN_CHESS960.match(parts[2]):
                return (
                    f"Invalid castling availability: '{parts[2]}' (expected some combination "
                    "of 'K', 'Q', 'k', 'q', rook-file letters 'a'-'h'/'A'-'H', or '-')."
                )
        elif not _CASTLING_PATTERN_STANDARD.match(parts[2]):
            return (
                f"Invalid castling availability: '{parts[2]}' "
                "(expected some combination of 'K', 'Q', 'k', 'q', or '-')."
            )
    if len(parts) >= 4 and not _EP_PATTERN.match(parts[3]):
        return (
            f"Invalid en-passant square: '{parts[3]}' "
            "(expected '-' or a valid target square such as 'e3' or 'd6')."
        )
    if len(parts) >= 5:
        try:
            hmc = int(parts[4])
            if hmc < 0:
                return "Halfmove clock must be a non-negative integer."
        except ValueError:
            return f"Invalid halfmove clock: '{parts[4]}' (expected a non-negative integer)."
    if len(parts) >= 6:
        try:
            fmc = int(parts[5])
            if fmc < 1:
                return "Fullmove number must be a positive integer."
        except ValueError:
            return f"Invalid fullmove number: '{parts[5]}' (expected a positive integer)."
    return None


def _validate_fen_format(variant: str, fen: str) -> str | None:
    return _validate_fen_parts(variant, fen.split())


# ── Signed-value helpers ──────────────────────────────────────────────────────
#
# WIN/CURSED_WIN/DRAW/BLESSED_LOSS/LOSE -> +2/+1/0/-1/-2, matching
# chess.syzygy's convention -- built from chess.chesstb's public class
# constants rather than its private _WDL_SIGNED, since this app has no
# reason to depend on a leading-underscore upstream symbol for a five-entry
# map it can just as easily own. This is what _probe_board below builds its
# signed wdl/dtc_wdl/dtm50_wdl fields on.

_SIGNED_WDL: dict[int, int] = {
    chesstb.WIN: 2, chesstb.CURSED_WIN: 1, chesstb.DRAW: 0,
    chesstb.BLESSED_LOSS: -1, chesstb.LOSE: -2,
}


def _signed_wdl(wdl: int) -> int | None:
    """Signed WDL for a raw wdl/dtc_wdl/dtm50_wdl class value."""
    return _SIGNED_WDL.get(wdl)


# ── Raw probe ─────────────────────────────────────────────────────────────────

def _probe_board(board: chess.Board) -> chesstb.ProbeResult | None:
    # A single combined probe() call computes WDL + DTZ + DTC + DTM + DTM50
    # together internally regardless of the requested fields. The raw ProbeResult
    # is returned as-is rather than copied field-by-field into a shape of
    # this app's own -- upstream's ProbeResult.__init__ already
    # zero-initialises dtz/dtc_order/dtc/dtm/dtm50 and sets
    # wdl/dtc_wdl/dtm50_wdl to ILLEGAL whenever the matching has_* flag is
    # False, so a caller reading those fields directly gets exactly the
    # same zeros a hand-built copy would have, and _signed_wdl() below
    # already maps ILLEGAL to None on its own -- no separate has_dtc/
    # has_dtm50 guard is needed around it either way. WDL is the only
    # metric required — a position whose WDL this app can't resolve isn't
    # probeable at all, and returns None. DTZ, DTC, DTM, and DTM50 are
    # each independently optional past that baseline; has_dtz/has_dtc/
    # has_dtm/has_dtm50 carry whichever of the four the loaded tables
    # actually answered for this position, and callers report the others
    # regardless of what those say.
    r = TB.probe(board, rule50=board.halfmove_clock)
    if r.status != "ok" or _signed_wdl(r.wdl) is None:
        return None
    return r


# ── Child-position probe cache ────────────────────────────────────────────────

class ProbeInFlightTimeout(Exception):
    """A probe of this FEN was already running and didn't finish in time.
    Retryable, exactly like the probe having timed out directly."""


class _InFlightProbe:
    """Slot for one probe in progress. The thread that creates it does the
    probing; every other thread asking for the same FEN waits on it."""

    __slots__ = ("done", "result", "error")

    def __init__(self) -> None:
        self.done   = threading.Event()
        self.result: chesstb.ProbeResult | None = None
        self.error:  BaseException | None = None


_inflight_lock = threading.Lock()
_inflight: dict[tuple[str, str], _InFlightProbe] = {}   # (variant, fen) -> slot

# Set (per calling thread) by _probe_fen_with_deadline below, so
# _probe_fen_deduped's in-flight wait can use a request's own remaining
# deadline instead of a fresh cfg.probe_timeout -- see that function's
# docstring for why a plain module-level value wouldn't work here. .board
# is set the same way, for the same reason, when the caller already has a
# chess.Board built from this exact fen in scope -- see
# _probe_fen_with_deadline's board parameter.
_probe_tls = threading.local()


def _probe_fen_deduped(variant: str, fen: str) -> chesstb.ProbeResult | None:
    """Runs at most one probe per (variant, fen) at a time, however many
    callers ask.

    _probe_fen's lru_cache only dedupes probes that have already *finished* —
    concurrent callers all miss it and all probe the same position. That
    happens routinely: /probe/stream pre-warms a child FEN that
    evaluate_all_moves then asks for again, and a retry after a timeout
    re-asks for a FEN whose first probe is still running. Each duplicate costs
    a full remote probe and occupies a pool worker.

    A non-owner's wait is bounded by the calling thread's own remaining
    deadline (see _probe_fen_with_deadline) so one hung probe can't pin a
    waiter beyond its own request's budget -- falling back to a fresh
    cfg.probe_timeout when no deadline was set, for a caller reached
    outside a deadline-aware path. The wait expiring raises, which reads
    downstream as a retryable failure just like the probe itself timing out.

    The owner builds the chess.Board to probe from (variant, fen) itself
    unless the calling thread already left one in _probe_tls.board (see
    _probe_fen_with_deadline's board parameter) -- for a root-fen probe,
    the caller has usually already built one anyway (to validate the FEN,
    render the board, etc.), and re-parsing the same string a second time
    here is pure waste. variant is required even when board is supplied,
    since it is also this function's in-flight/dedup key -- the same FEN
    text probes to a different (and possibly incompatible) result under
    Standard vs Chess960 rules (see the module-level variant comment), so
    a key of fen alone would let one variant's probe be served to the
    other's caller.
    """
    key = (variant, fen)
    with _inflight_lock:
        slot = _inflight.get(key)
        if slot is None:
            slot = _inflight[key] = _InFlightProbe()
            owner = True
        else:
            owner = False

    if not owner:
        deadline = getattr(_probe_tls, "deadline", None)
        timeout = (deadline - time.monotonic()) if deadline is not None else cfg.probe_timeout
        if timeout <= 0 or not slot.done.wait(max(0, timeout)):
            raise ProbeInFlightTimeout(f"Timed out waiting on an in-flight probe of variant={variant} {fen}")
        if slot.error is not None:
            raise slot.error
        return slot.result

    try:
        board = getattr(_probe_tls, "board", None)
        slot.result = _probe_board(board if board is not None else _build_board(variant, fen))
        return slot.result
    except BaseException as exc:
        slot.error = exc
        raise
    finally:
        # Drop the slot before waking the waiters, so a caller arriving in
        # between starts a fresh probe rather than joining a finished one.
        with _inflight_lock:
            _inflight.pop(key, None)
        slot.done.set()


@lru_cache(maxsize=cfg.probe_cache_size)
def _probe_fen(variant: str, fen: str) -> chesstb.ProbeResult | None:
    return _probe_fen_deduped(variant, fen)


def _probe_fen_with_deadline(
    variant: str, fen: str, deadline: float | None, board: chess.Board | None = None,
) -> chesstb.ProbeResult | None:
    """Calls _probe_fen(variant, fen), but first makes `deadline` (and,
    optionally, `board`) visible to _probe_fen_deduped's in-flight wait /
    owner branch on *this* thread.

    _probe_fen must stay a (variant, fen)-only lru_cache -- adding deadline
    as a real parameter would make it part of the cache key, and since a
    deadline is different on every call, that would turn the cache into a
    permanent miss. A plain thread-local set by the caller doesn't work
    either when this runs via _executor.submit(_probe_fen_with_deadline,
    variant, fen, ...): submit() runs the call on a pool worker thread, not
    the submitting thread, so a thread-local the submitter set wouldn't be
    visible there. Passing deadline as a real argument to *this* wrapper --
    called either directly or as the submitted callable itself -- sidesteps
    both problems: it's a normal argument up to here, then becomes this
    worker thread's own thread-local for the duration of the call.

    board is optional and exists purely to avoid re-parsing a FEN this
    thread already has a chess.Board for -- pass it only when `board` was
    itself built from this exact (variant, fen) pair, right here, in this
    same function call's caller, moments before this call. _probe_fen_deduped
    has no way to verify the two actually match (board.fen() isn't
    reliably equal to a shortened/unpadded input fen string, so comparing
    them isn't a safety net either), so passing a board that doesn't
    correspond to (variant, fen) silently returns a wrong probe result.
    Never pass this for a child fen, which is only ever known as a string,
    not as a board this thread built -- leave it at the default None there.
    """
    _probe_tls.deadline = deadline
    _probe_tls.board = board
    try:
        return _probe_fen(variant, fen)
    finally:
        _probe_tls.deadline = None
        _probe_tls.board = None



# ── Move evaluation ───────────────────────────────────────────────────────────

def _apply_sign(magnitude: int, sign_wdl: int) -> int:
    """Gives an unsigned ply magnitude the sign implied by a signed WDL
    value: positive for a winning sign_wdl, negative for a losing one,
    zero for a draw. Shared by every DTZ/DTC/DTM/DTM50 assembly step in
    evaluate_all_moves below, so the four metrics can't drift apart on
    how a magnitude gets its sign."""
    if sign_wdl > 0:
        return magnitude
    if sign_wdl < 0:
        return -magnitude
    return 0


def _collect_move_info(board: chess.Board) -> list[tuple[str, bool, bool, bool, str | None, str | None, chess.Board | None]]:
    move_info: list[tuple[str, bool, bool, bool, str | None, str | None, chess.Board | None]] = []
    for move in board.legal_moves:
        san = board.san(move)
        # Bypasses expensive Board.is_checkmate() checks by parsing the SAN string directly
        move_is_mate = san.endswith("#")
        move_is_zeroing = board.is_zeroing(move)
        # DTC's own notion of "conversion" (a capture or a promotion) is
        # narrower than move_is_zeroing (capture OR any pawn move): a quiet
        # pawn push zeroes the clock too, but chess.chesstb.Tablebase.
        # _dtc_move_kind does not treat it as a conversion, only as one of
        # the pushes the winning side still owes (see the DTC row below,
        # this field's only consumer). is_capture() rather than a bare
        # to-square occupancy check so an
        # en passant capture — whose destination square is empty — still
        # counts as a conversion here.
        move_is_conversion = board.is_capture(move) or move.promotion is not None
        draw_reason: str | None = None
        child_board: chess.Board | None = None
        board.push(move)
        try:
            if not move_is_mate:
                # Bypasses Board.is_stalemate() by stopping at the first legal move found
                if not any(board.generate_legal_moves()):
                    draw_reason = "stalemate"
                elif board.is_insufficient_material():
                    draw_reason = "insufficient_material"
            child_fen: str | None = None if (move_is_mate or draw_reason) else board.fen()
            if child_fen is not None:
                # Upstream probes positions, not repetition history. Preserve
                # the clock, en passant and Chess960 state without the stack.
                child_board = board.copy(stack=False)
        finally:
            board.pop()
        move_info.append((san, move_is_mate, move_is_zeroing, move_is_conversion, draw_reason, child_fen, child_board))
    return move_info


def evaluate_all_moves(
    board: chess.Board,
    root_wdl: int,
    variant: str = "standard",
    bypass_parallel: bool = False,
    precomputed_move_info: list[tuple[str, bool, bool, bool, str | None, str | None, chess.Board | None]] | None = None,
    deadline: float | None = None,
) -> tuple[MoveList, MoveList, MoveList, MoveList, bool, dict[str, int]]:
    """Returns the four ranked move lists (DTZ, DTC, DTM, DTM50, in that
    order), a "complete" flag: False when at least one move shows "unknown"
    for a retryable reason (probe timeout or error) rather than because its
    table is genuinely absent (callers use it to decide whether the result
    is worth caching — see evaluate_fen()), and the wins/draws/losses/
    unknown summary across all legal moves.

    variant applies to every child position probed below, matching the
    ruleset `board` itself was built under (see _build_board) -- board.push()/
    pop() inside _collect_move_info already preserves board.chess960 for
    move generation and child.fen() serialization for free, since it's the
    same Board object throughout; variant only needs to be threaded through
    explicitly here because child positions are (re-)probed from their FEN
    string, not from the Board object itself (see _probe_fen_with_deadline).

    deadline is an absolute time.monotonic() value bounding child probing."""
    effective_deadline = deadline if deadline is not None else time.monotonic() + cfg.probe_timeout

    # Phase 1: collect move metadata (no TB calls) — reuses the caller's own
    # pass over board.legal_moves() when one is supplied, instead of
    # re-walking every legal move a second time for the same board.
    move_info = precomputed_move_info if precomputed_move_info is not None else _collect_move_info(board)

    # Phase 2: probe child positions
    unique_fens: set[str] = {child_fen for _, _, _, _, _, child_fen, _ in move_info if child_fen is not None}
    probe_cache: dict[str, chesstb.ProbeResult | None] = {}
    child_boards: dict[str, chess.Board] = {
        child_fen: child_board
        for _, _, _, _, _, child_fen, child_board in move_info
        if child_fen is not None and child_board is not None
    }

    # Child FENs that failed for a retryable reason. A probe that timed out is
    # still running in the pool and will populate _probe_fen's own cache, so a
    # later attempt at this position resolves it; a probe that raised may
    # succeed on a retry too. Neither is the same as _probe_fen returning None,
    # which means tb_not_found and won't change however often it's re-probed.
    transient_failures: set[str] = set()

    # Probe sufficiently large uncached batches through the thread pool.
    if len(unique_fens) >= cfg.parallel_threshold and not bypass_parallel:
        futures = {
            fen: _executor.submit(
                _probe_fen_with_deadline, variant, fen, effective_deadline, child_boards.get(fen)
            )
            for fen in unique_fens
        }
        remaining = max(0.0, effective_deadline - time.monotonic())
        done, _ = futures_wait(
            futures.values(), timeout=remaining, return_when=ALL_COMPLETED
        )
        for fen, fut in futures.items():
            if fut in done:
                try:
                    probe_cache[fen] = fut.result()
                except Exception as exc:
                    log.warning("Probe error for variant=%s %s: %s", variant, fen, exc)
                    probe_cache[fen] = None
                    transient_failures.add(fen)
            else:
                log.warning("Probe timed out for variant=%s %s", variant, fen)
                probe_cache[fen] = None
                transient_failures.add(fen)
    else:
        # Probe smaller batches, and batches whose children are already cached,
        # sequentially to avoid unnecessary thread-pool overhead.
        for fen in unique_fens:
            try:
                probe_cache[fen] = _probe_fen_with_deadline(
                    variant, fen, effective_deadline, child_boards.get(fen)
                )
            except Exception as exc:
                log.warning("Probe error for variant=%s %s: %s", variant, fen, exc)
                probe_cache[fen] = None
                transient_failures.add(fen)

    # Phase 3: assemble and sort
    dtz_rows:   list[tuple] = []
    dtc_rows:   list[tuple] = []
    dtm_rows:   list[tuple] = []
    dtm50_rows: list[tuple] = []

    # Outcome per move for the response's summary counts (see
    # _evaluate_fen_impl) — WDL alone, independent of which of
    # DTZ/DTC/DTM/DTM50 this material's tables actually cover, since any one
    # of those columns can end up entirely "not_available" below.
    move_outcomes: list[str] = []

    # Sort key/entry pair for a move whose own metric table doesn't cover
    # it: flatly "Not Available", the same shape for DTZ, DTC, DTM, and
    # DTM50 alike rather than a value borrowed from another metric.
    # has_order adds DTC's extra pushes-owed slot to the sort key.
    def _not_available(
        san: str, child_fen: str | None, move_is_mate: bool,
        draw_reason: str | None, has_order: bool = False,
    ) -> tuple[tuple, MoveEntry]:
        key = (_outcome_rank(0) + 10, 0, 0, san) if has_order else (_outcome_rank(0) + 10, 0, san)
        entry: MoveEntry = {
            "san": san, "plies": 0, "order": 0, "is_mate": move_is_mate, "available": False,
            "outcome": "not_available", "child_fen": child_fen, "draw_reason": draw_reason,
        }
        return key, entry

    for san, move_is_mate, move_is_zeroing, move_is_conversion, draw_reason, child_fen, _child_board in move_info:

        if move_is_mate:
            opp_wdl = opp_dtc_wdl = opp_dtm50_wdl = -2
            opp_dtz = opp_dtc = opp_dtc_order = opp_dtm = opp_dtm50 = 0
            opp_has_dtz = opp_has_dtc = opp_has_dtm = opp_has_dtm50 = True

        elif draw_reason:
            opp_wdl = opp_dtc_wdl = opp_dtm50_wdl = 0
            opp_dtz = opp_dtc = opp_dtc_order = opp_dtm = opp_dtm50 = 0
            opp_has_dtz = opp_has_dtc = opp_has_dtm = opp_has_dtm50 = True

        else:
            probe_result = probe_cache.get(child_fen)
            if probe_result is None:
                log.warning("No probe result for %s (%s); showing unknown.", child_fen, san)
                stub: MoveEntry = {
                    "san": san, "plies": 0, "order": 0, "is_mate": False, "available": False,
                    "outcome": "unknown", "child_fen": child_fen, "draw_reason": None,
                }
                stub_key = (_outcome_rank(0) + 10, 0, san)
                dtc_stub_key = (_outcome_rank(0) + 10, 0, 0, san)
                dtz_rows.append((stub_key, stub))
                dtc_rows.append((dtc_stub_key, stub))
                dtm_rows.append((stub_key, stub))
                dtm50_rows.append((stub_key, stub))
                move_outcomes.append("unknown")
                continue
            opp_wdl = _signed_wdl(probe_result.wdl)
            opp_has_dtz, opp_dtz = probe_result.has_dtz, probe_result.dtz
            opp_has_dtc = probe_result.has_dtc
            opp_dtc_wdl = _signed_wdl(probe_result.dtc_wdl)
            opp_dtc_order, opp_dtc = probe_result.dtc_order, probe_result.dtc
            opp_has_dtm, opp_dtm = probe_result.has_dtm, probe_result.dtm
            opp_has_dtm50 = probe_result.has_dtm50
            opp_dtm50_wdl = _signed_wdl(probe_result.dtm50_wdl)
            opp_dtm50 = probe_result.dtm50

        my_wdl = -opp_wdl
        move_outcomes.append(_outcome_label(_capped_wdl(my_wdl, root_wdl)))

        # DTZ row.
        if opp_has_dtz:
            my_dtz = _apply_sign(opp_dtz, my_wdl)
            # If this move is itself a zeroing move (capture/pawn-push/
            # promotion), it IS the zeroing move, so its DTZ is 1 ply — not
            # 1 + the child position's own distance to *its* next
            # zeroing move, which is what feeding my_dtz straight into
            # _effective_distance would compute (double-counting a second
            # zeroing event nobody asked for). _effective_distance
            # already has a branch for exactly this ("no further distance
            # needed, the move itself resolves it"), so call it with
            # raw_distance=0 instead of reimplementing that branch here.
            eff_dtz = (_effective_distance(my_wdl, 0) if move_is_zeroing
                       else _effective_distance(my_wdl, my_dtz))
            eff_wdl = _effective_move_wdl(my_wdl, root_wdl, eff_dtz)
            outcome = _outcome_label(eff_wdl)
            dtz_key = (_outcome_rank(eff_wdl), _ply_rank(eff_wdl, eff_dtz), san)
            dtz_rows.append((dtz_key, {
                "san": san, "plies": abs(eff_dtz), "order": 0, "is_mate": move_is_mate, "available": True,
                "outcome": outcome, "child_fen": child_fen, "draw_reason": draw_reason,
            }))
        else:
            dtz_rows.append(_not_available(san, child_fen, move_is_mate, draw_reason))

        # DTC row. DTC's own notion of a better move is pushes-owed first, then
        # plies (see _order_rank's docstring), so the sort key carries both,
        # unlike DTZ/DTM/DTM50 above and below which only ever compare
        # plies.
        #
        # A capture or a promotion (move_is_conversion) *is* the conversion,
        # here and now: 0 pushes still owed, 1 ply to get there — the
        # child's own pushes/plies describe its next, later conversion,
        # which is irrelevant once this one has already happened.
        #
        # A quiet pawn push zeroes the clock too (move_is_zeroing) but is
        # NOT a conversion — chess.chesstb.Tablebase._dtc_move_kind treats
        # it as spending one of the pushes still owed rather than settling
        # the count, so the wait still resets to 1 ply the same way a
        # conversion's does, but pushes owed does not reset to 0.
        #
        # The child is probed at its own halfmove clock (see _probe_board)
        # and its own dtc_order counts pushes owed from THAT position
        # onward — it does not, and cannot, know about the push that was
        # just spent getting there, since that push is already in the
        # past as far as the child's own position is concerned. Verified
        # directly against the table: for a root reporting dtc_order=N
        # whose own best move is a push, the resulting child reports
        # dtc_order=N-1, not N — so the +1 below is not re-deriving
        # something the child's probe already contains, it is restoring
        # the one push this exact move spent that the child's own,
        # correctly-fresh count no longer includes.
        #
        # Whether the +1 applies depends on which side is pushing: dtc_order
        # counts the pushes still owed by whichever side is winning, and
        # only the WINNING side's own push spends one of them. A defensive
        # push by the losing side leaves that budget untouched, so it
        # carries the child's order over unchanged, same as a quiet move —
        # hence the my_dtc_wdl > 0 guard below.
        if opp_has_dtc:
            my_dtc_wdl = -opp_dtc_wdl
            if move_is_mate or draw_reason or move_is_conversion:
                # A capture, a promotion, checkmate, or an immediate draw
                # are all fully resolved right here: 0 pushes still owed,
                # 1 ply to get there. move_is_mate/draw_reason already
                # hardwire opp_dtc_order/opp_dtc to 0 above, so this is a
                # no-op arithmetically for those in the ordinary case — it
                # matters for the case where the move is *also* a quiet
                # pawn push, e.g. checkmate delivered by discovered check
                # from a pawn advance that neither captures nor promotes.
                # Without this guard that would fall into the push branch
                # below and pick up a spurious +1: mate ends the game, so
                # nothing is owed no matter how the pawn got there.
                raw_order = 0
                eff_dtc = _effective_distance(my_dtc_wdl, 0)
            elif move_is_zeroing:  # a quiet pawn push, not a conversion
                raw_order = opp_dtc_order + (1 if my_dtc_wdl > 0 else 0)
                eff_dtc = _effective_distance(my_dtc_wdl, 0)
            else:
                raw_order = opp_dtc_order
                my_dtc = _apply_sign(opp_dtc, my_dtc_wdl)
                eff_dtc = _effective_distance(my_dtc_wdl, my_dtc)
            # A draw has nothing owed regardless of the raw push count
            # above — e.g. a defensive push into a dead draw (stalemate,
            # insufficient material, or a budget that no longer fits the
            # clock) must not report a nonzero push count just because it
            # happened to be a push; _order_rank sorts it correctly either
            # way (it treats wdl_val == 0 as rank 0 regardless), but the
            # value shown to the client should read 0 like plies does.
            eff_order = raw_order if my_dtc_wdl != 0 else 0
            dtc_key = (
                _outcome_rank(my_dtc_wdl),
                _order_rank(my_dtc_wdl, eff_order),
                _ply_rank(my_dtc_wdl, eff_dtc),
                san,
            )
            dtc_rows.append((dtc_key, {
                "san": san, "plies": abs(eff_dtc), "order": eff_order, "is_mate": move_is_mate,
                "available": True, "outcome": _outcome_label(my_dtc_wdl),
                "child_fen": child_fen, "draw_reason": draw_reason,
            }))
        else:
            dtc_rows.append(_not_available(san, child_fen, move_is_mate, draw_reason, has_order=True))

        # DTM row.
        if opp_has_dtm:
            my_dtm = _apply_sign(opp_dtm, my_wdl)
            eff_dtm = _effective_distance(my_wdl, my_dtm)
            if opp_has_dtz:
                # DTZ and DTM share the same win/cursed-win (loss/blessed-
                # loss) bucket and label as the DTZ row above, since that
                # status is a single fact about eff_dtz and root_wdl rather
                # than a separate one per metric.
                dtm_key = (_outcome_rank(eff_wdl), _ply_rank(eff_wdl, eff_dtm), san)
                dtm_outcome = outcome
            else:
                # No DTZ on this material to derive a shared bucket from --
                # fall back to DTM's own distance for the win/cursed-win
                # split instead.
                dtm_eff_wdl = _effective_move_wdl(my_wdl, root_wdl, eff_dtm)
                dtm_key = (_outcome_rank(dtm_eff_wdl), _ply_rank(dtm_eff_wdl, eff_dtm), san)
                dtm_outcome = _outcome_label(dtm_eff_wdl)
            dtm_rows.append((dtm_key, {
                "san": san, "plies": abs(eff_dtm), "order": 0, "is_mate": move_is_mate, "available": True,
                "outcome": dtm_outcome, "child_fen": child_fen, "draw_reason": draw_reason,
            }))
        else:
            dtm_rows.append(_not_available(san, child_fen, move_is_mate, draw_reason))

        # DTM50 row.
        if opp_has_dtm50:
            my_dtm50_wdl = -opp_dtm50_wdl
            my_dtm50 = _apply_sign(opp_dtm50, my_dtm50_wdl)
            eff_dtm50 = _effective_distance(my_dtm50_wdl, my_dtm50)
            dtm50_key = (_outcome_rank(my_dtm50_wdl), _ply_rank(my_dtm50_wdl, eff_dtm50), san)
            dtm50_rows.append((dtm50_key, {
                "san": san, "plies": abs(eff_dtm50), "order": 0, "is_mate": move_is_mate, "available": True,
                "outcome": _outcome_label(my_dtm50_wdl), "child_fen": child_fen, "draw_reason": draw_reason,
            }))
        else:
            dtm50_rows.append(_not_available(san, child_fen, move_is_mate, draw_reason))

    dtz_rows.sort(key=lambda r: r[0])
    dtc_rows.sort(key=lambda r: r[0])
    dtm_rows.sort(key=lambda r: r[0])
    dtm50_rows.sort(key=lambda r: r[0])

    summary = {
        "wins":    sum(1 for o in move_outcomes if o in ("win", "cursed_win")),
        "draws":   sum(1 for o in move_outcomes if o == "draw"),
        "losses":  sum(1 for o in move_outcomes if o in ("loss", "blessed_loss")),
        "unknown": sum(1 for o in move_outcomes if o == "unknown"),
    }

    return (
        [r[1] for r in dtz_rows],
        [r[1] for r in dtc_rows],
        [r[1] for r in dtm_rows],
        [r[1] for r in dtm50_rows],
        not transient_failures,
        summary,
    )


# ── Root Probe Calculation ────────────────────────────────────────────────────

_evaluate_tls = threading.local()


def _validate_and_build_board(variant: str, fen: str) -> chess.Board:
    """
    Single authoritative implementation of root-FEN validation, shared by
    /probe (via evaluate_fen) and /probe/stream (which needs a validated
    board up front, before it can start emitting SSE progress events).
    Raises RuntimeError if the tablebase isn't loaded, or ValueError for any
    FEN/board problem — callers are expected to catch and format those.

    Legality (castling rights matching an actual king/rook pair, no pawns
    on the back rank, exactly one king per side, etc.) is entirely
    delegated to board.is_valid() for both variants -- this function adds
    no Standard-only assumptions of its own (e.g. requiring castling rooks
    on a1/h1/a8/h8) that would misclassify a legal Chess960 position as
    invalid. See _build_board for how the variant affects construction.
    """
    if TB is None:
        raise RuntimeError(
            "Tablebase not initialised. Check TABLEBASE_PATH / TABLEBASE_PATH_7_8 / "
            "TABLEBASE_PATH_CASTLING.")

    parts = fen.split()
    fmt_error = _validate_fen_parts(variant, parts)
    if fmt_error:
        raise ValueError(fmt_error)

    try:
        board = _build_board(variant, fen)
    except ValueError as e:
        raise ValueError(f"Malformed FEN: {e}") from e

    castling_field = parts[2] if len(parts) >= 3 else "-"
    if variant == "chess960" and castling_field != "-":
        if board.castling_rights.bit_count() != len(castling_field):
            raise ValueError("Invalid castling availability: duplicate castling rights.")

    if not board.is_valid():
        raise ValueError(
            "Invalid board position (missing kings, adjacent kings, pawn on "
            "back rank, a castling right with no matching king/rook pair, etc.)."
        )

    return board


def _missing_table_error_payload(variant: str, fen: str) -> dict:
    """
    Single authoritative shape for the "position not covered by the loaded
    tablebase" error, shared by /probe and /probe/stream so the two
    transports (plain JSON vs SSE) can't drift out of sync on wording,
    error_code, or how piece_count is computed.
    """
    try:
        piece_count = len(_build_board(variant, fen).piece_map())
    except Exception:
        piece_count = None
    return {
        "error":       "Position not covered by the loaded tablebase.",
        "error_code":  "missing_table",
        "piece_count": piece_count,
    }


class _IncompleteResult(Exception):
    """Carries a probe result that must not be cached — see evaluate_fen()."""

    def __init__(self, json_str: str) -> None:
        super().__init__("probe incomplete")
        self.json_str = json_str


def _evaluate_fen_impl(variant: str, fen: str) -> str:
    """
    Probes the tablebase for a root FEN and returns a pre-serialized JSON string.
    Routes the root probe through the same shared _probe_fen cache used for
    child positions, so a position that was just probed as a child (e.g. the
    position the user just moved into) is served from cache instead of
    re-hitting the tablebase.

    (variant, fen) are the only arguments (required for @lru_cache to key on
    them), so a caller that already built a board/move_info for this exact
    pair -- e.g. probe_stream()'s SSE handler, which needs both up front
    anyway to size its progress bar -- hands them over via _evaluate_tls
    instead, letting this call skip redoing that work. Ignored on a cache
    hit, since the function body below never runs in that case.

    Raises _IncompleteResult (carrying the same JSON) when a move came back
    unknown for a retryable reason, so evaluate_fen() can serve it without
    caching it.
    """
    precomputed_board     = getattr(_evaluate_tls, "board", None)
    precomputed_move_info = getattr(_evaluate_tls, "move_info", None)
    board = precomputed_board if precomputed_board is not None else _validate_and_build_board(variant, fen)

    # A fresh cfg.probe_timeout-sized budget for the root probe alone,
    # independent of how long any earlier phase of the same request (e.g.
    # probe_stream()'s own pre-warm step) already took, so a slow earlier
    # phase cannot erode the time this one gets. The child batch below
    # carries its own equally-sized fresh budget (see child_deadline),
    # matching the independent-budget-per-phase pattern probe_stream()
    # applies between its pre-warm step and the root probe above it. The
    # two independently-budgeted phases put a single /probe request's
    # worst case at up to 2 * cfg.probe_timeout.
    root_deadline = time.monotonic() + cfg.probe_timeout

    if board.is_checkmate():
        return json.dumps({
            "wdl": -2, "dtz": 0, "dtc": [-2, 0, 0], "dtm": 0, "dtm50": [-2, 0],
            "dtz_available": True, "dtc_available": True, "dtm_available": True, "dtm50_available": True,
            "moves_dtz": [], "moves_dtc": [], "moves_dtm": [], "moves_dtm50": [],
            "summary": {"wins": 0, "draws": 0, "losses": 0, "unknown": 0},
            "draw_reason": None,
        })

    if board.is_stalemate() or board.is_insufficient_material():
        return json.dumps({
            "wdl": 0, "dtz": 0, "dtc": [0, 0, 0], "dtm": 0, "dtm50": [0, 0],
            "dtz_available": True, "dtc_available": True, "dtm_available": True, "dtm50_available": True,
            "moves_dtz": [], "moves_dtc": [], "moves_dtm": [], "moves_dtm50": [],
            "summary": {"wins": 0, "draws": 0, "losses": 0, "unknown": 0},
            "draw_reason": "stalemate" if board.is_stalemate() else "insufficient_material",
        })

    # Route the root probe through the shared child-probe cache. board was
    # either handed over via _evaluate_tls or just built above from this
    # exact fen, so it's passed through here too rather than making
    # _probe_fen_deduped re-parse the same string a second time.
    root = _probe_fen_with_deadline(variant, fen, root_deadline, board)
    if root is None:
        raise chesstb.MissingTableError(f"Position not in tablebase: variant={variant} {fen}")

    bypass_parallel = getattr(_evaluate_tls, "bypass_parallel", False)
    # Own fresh budget, not the remainder of root_deadline -- see the
    # comment above root_deadline.
    child_deadline = time.monotonic() + cfg.probe_timeout
    moves_dtz, moves_dtc, moves_dtm, moves_dtm50, complete, summary = evaluate_all_moves(
        board, _signed_wdl(root.wdl), variant, bypass_parallel=bypass_parallel,
        precomputed_move_info=precomputed_move_info, deadline=child_deadline,
    )

    # dtz/dtc/dtm/dtm50 are the root's own metrics, each independently
    # unavailable when this material has no DTZ/DTC/DTM/DTM50 table — see
    # _probe_board. The paired *_available flag is the authoritative signal
    # for that; the value fields fall back to null/[null, null(, null)]
    # rather than being omitted, so every response has the same fixed shape
    # regardless of coverage. dtc is a 3-tuple [wdl, pushes_owed, plies]
    # rather than dtm50's pair, since — unlike dtm50 — its distance is
    # priced in two components, not one; see chess.chesstb.ProbeResult and
    # the DTC row comment in evaluate_all_moves. root is the raw
    # ProbeResult _probe_board returns, so its wdl/dtc_wdl/dtm50_wdl are
    # still the unsigned chess.chesstb class values here — each goes
    # through _signed_wdl() below, same as every other consumer of a raw
    # ProbeResult in this file.
    json_str = json.dumps({
        "wdl":              _signed_wdl(root.wdl),
        "dtz":              root.dtz if root.has_dtz else None,
        "dtz_available":    root.has_dtz,
        "dtc":              [_signed_wdl(root.dtc_wdl), root.dtc_order, root.dtc] if root.has_dtc else [None, None, None],
        "dtc_available":    root.has_dtc,
        "dtm":              root.dtm if root.has_dtm else None,
        "dtm_available":    root.has_dtm,
        "dtm50":            [_signed_wdl(root.dtm50_wdl), root.dtm50] if root.has_dtm50 else [None, None],
        "dtm50_available":  root.has_dtm50,
        "moves_dtz":        moves_dtz,
        "moves_dtc":        moves_dtc,
        "moves_dtm":        moves_dtm,
        "moves_dtm50":      moves_dtm50,
        "summary":          summary,
        "draw_reason":      None,   # root always has legal moves here, so never terminal
    })
    if not complete:
        raise _IncompleteResult(json_str)
    return json_str


# The cache lives on the inner function only: lru_cache never stores the result
# of a call that raised, so an _IncompleteResult passes straight through to the
# caller without being memoized, and the next request for that (variant, fen)
# re-probes. By then the timed-out probes have usually landed in _probe_fen's
# own cache, so the retry is both cheap and likely to resolve. Without this a
# single timeout pinned "unknown" to a position for the rest of the process,
# with /admin/cache/clear the only way out.
@lru_cache(maxsize=cfg.evaluate_cache_size)
def _evaluate_fen_cached(variant: str, fen: str) -> str:
    return _evaluate_fen_impl(variant, fen)


def evaluate_fen(variant: str, fen: str) -> str:
    try:
        return _evaluate_fen_cached(variant, fen)
    except _IncompleteResult as incomplete:
        return incomplete.json_str


evaluate_fen.cache_clear = _evaluate_fen_cached.cache_clear  # type: ignore[attr-defined]
evaluate_fen.cache_info  = _evaluate_fen_cached.cache_info   # type: ignore[attr-defined]


# ── Common (variant, FEN) extraction + validation helper ──────────────────────

def _extract_probe_request(data: dict | None) -> tuple[str, str, Response | tuple[Response, int] | None]:
    """Single authoritative request-body parser shared by /probe and
    /probe/stream, so the two transports can't drift on what counts as a
    valid variant/FEN or how each is rejected. Returns (variant, fen,
    error_response); error_response is None on success and variant/fen are
    both "" when it isn't."""
    if not data or "fen" not in data:
        return "", "", (jsonify({"error": "Missing FEN in request body."}), 400)
    fen_raw = data["fen"]
    if not isinstance(fen_raw, str):
        return "", "", (jsonify({"error": "FEN must be a string."}), 400)
    fen = fen_raw.strip()
    if not fen:
        return "", "", (jsonify({"error": "FEN string is empty."}), 400)
    if len(fen) > cfg.max_fen_length:
        return "", "", (jsonify({"error": f"FEN string too long (max {cfg.max_fen_length})."}), 400)

    try:
        variant = _normalize_variant(data.get("variant"))
    except ValueError as e:
        return "", "", (jsonify({"error": str(e)}), 400)

    return variant, _normalize_fen(fen), None


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index() -> str:
    return render_template("index.html", github_url=cfg.github_url)


@app.route("/probe", methods=["POST"])
@_probe_rate_limit
def probe() -> Response | tuple[Response, int]:
    body = request.get_json(silent=True)
    variant, fen, err = _extract_probe_request(body)
    if err:
        return err

    try:
        json_str = evaluate_fen(variant, fen)
        return app.response_class(json_str, status=200, mimetype="application/json")

    except chesstb.MissingTableError:
        return jsonify(_missing_table_error_payload(variant, fen)), 400

    except RuntimeError as e:
        # Tablebase not initialised (TABLEBASE_PATH, TABLEBASE_PATH_7_8,
        # and TABLEBASE_PATH_CASTLING all unset, or all failed to load) --
        # same condition and status code as /health's own "degraded"
        # response for this, and the same message _validate_and_build_board
        # raises for /probe/stream to report over SSE.
        return jsonify({"error": str(e)}), 503

    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    except _REMOTE_SOURCE_ERROR as e:
        log.warning("Remote tablebase fetch failed probing variant=%s FEN %s: %s", variant, fen, e)
        return jsonify({
            "error": "Could not reach the remote tablebase. Try again shortly.",
            "error_code": "remote_unavailable",
        }), 502

    except ProbeInFlightTimeout as e:
        log.warning("%s", e)
        return jsonify({
            "error": "Probe timed out. Try again shortly.",
            "error_code": "probe_timeout",
        }), 503

    except Exception:
        log.exception("Unhandled error probing variant=%s FEN: %s", variant, fen)
        return jsonify({"error": "Internal server error."}), 500


def _stream_error_payload(variant: str, fen: str, exc: BaseException) -> dict:
    """SSE error payload for an exception raised while probing (variant, fen),
    keeping wording, error_code, and logging identical no matter which probe
    step inside probe_stream() raised it."""
    if isinstance(exc, chesstb.MissingTableError):
        return {"status": "error", **_missing_table_error_payload(variant, fen)}
    if isinstance(exc, _REMOTE_SOURCE_ERROR):
        log.warning("Remote tablebase fetch failed in probe/stream for variant=%s %s: %s", variant, fen, exc)
        return {
            "status": "error",
            "error": "Could not reach the remote tablebase. Try again shortly.",
            "error_code": "remote_unavailable",
        }
    if isinstance(exc, ProbeInFlightTimeout):
        log.warning("%s", exc)
        return {
            "status": "error",
            "error": "Probe timed out. Try again shortly.",
            "error_code": "probe_timeout",
        }
    log.exception("Error in probe/stream for variant=%s %s", variant, fen)
    return {"status": "error", "error": str(exc)}


@app.route("/probe/stream", methods=["POST"])
@_probe_rate_limit
def probe_stream() -> Response | tuple[Response, int]:
    body = request.get_json(silent=True)
    variant, fen, err = _extract_probe_request(body)
    if err:
        return err

    def _sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    def generate():
        # Validated up front (rather than only inside evaluate_fen below) so
        # the validation error can be reported immediately over SSE instead of
        # only finding out after pre-warming child positions. Uses the same
        # _validate_and_build_board() that evaluate_fen() itself calls, so
        # there's one authoritative implementation of "what makes a FEN
        # probeable" instead of two hand-written copies that could disagree.
        try:
            root_board = _validate_and_build_board(variant, fen)
        except (RuntimeError, ValueError) as e:
            yield _sse({"status": "error", "error": str(e)})
            return

        # A terminal root (checkmate, stalemate, insufficient material) never
        # reaches the tablebase — see evaluate_fen()'s own early return for
        # these — so only a non-terminal root needs its coverage confirmed
        # here. Checking the root before pre-warming any child means a root
        # the tablebase doesn't cover is caught immediately: no child of an
        # uncovered root is coverable either, so pre-warming first would only
        # probe the entire move list to discover that after the fact. This
        # reads through the same cache evaluate_fen() itself reads below, so
        # a covered root costs nothing extra downstream.
        terminal = (
            root_board.is_checkmate()
            or root_board.is_stalemate()
            or root_board.is_insufficient_material()
        )
        if not terminal:
            try:
                # root_board was just built above from this exact (variant,
                # fen), so it's passed through here too rather than making
                # _probe_fen_deduped re-parse the same string a second
                # time -- see _probe_fen_with_deadline's board parameter.
                root_probe = _probe_fen_with_deadline(
                    variant, fen, time.monotonic() + cfg.probe_timeout, root_board,
                )
            except Exception as e:
                yield _sse(_stream_error_payload(variant, fen, e))
                return
            if root_probe is None:
                yield _sse({"status": "error", **_missing_table_error_payload(variant, fen)})
                return

        # Insufficient-material draws can still have legal moves, but
        # evaluate_fen returns a terminal response without using children.
        move_info = [] if terminal else _collect_move_info(root_board)
        child_fens: set[str] = {
            child_fen for _, _, _, _, _, child_fen, _ in move_info if child_fen is not None
        }
        child_boards: dict[str, chess.Board] = {
            child_fen: child_board
            for _, _, _, _, _, child_fen, child_board in move_info
            if child_fen is not None and child_board is not None
        }

        total = len(child_fens)
        yield _sse({"status": "probing", "completed": 0, "total": total})

        # Pre-warm child FENs in parallel using the native non-blocking cache.
        # Always via the thread pool (regardless of cfg.parallel_threshold, which
        # only governs evaluate_all_moves' own sequential/parallel choice below) —
        # a bare sequential loop here would have no way to bound a single hung
        # _probe_fen_with_deadline() call, since there'd be no worker thread to
        # poll against; only a background thread lets this deadline actually
        # cut the wait short. This budget is independent of the root probe's
        # own, above — a slow root probe doesn't eat into pre-warm's time.
        deadline = time.monotonic() + cfg.probe_timeout
        futures = {
            cf: _executor.submit(
                _probe_fen_with_deadline, variant, cf, deadline, child_boards.get(cf)
            )
            for cf in child_fens
        }
        remaining = set(futures.values())
        done_count = 0
        prewarm_complete = True
        while done_count < total:
            time_left = deadline - time.monotonic()
            if time_left <= 0:
                log.warning(
                    "Probe pre-warm timed out for variant=%s %s (%d/%d child positions still pending)",
                    variant, fen, total - done_count, total,
                )
                prewarm_complete = False
                break
            newly_done, remaining = futures_wait(
                remaining, timeout=min(0.3, time_left), return_when=FIRST_COMPLETED
            )
            done_count += len(newly_done)
            yield _sse({"status": "probing", "completed": done_count, "total": total})

        # If pre-warming above finished, every child FEN is already cached, so
        # evaluate_fen() below can fetch them all as cache hits sequentially,
        # without the overhead of resubmitting each one to the thread pool. If
        # pre-warming timed out instead, skip that shortcut: evaluate_all_moves()
        # inside evaluate_fen() then takes its own parallel path, with its own
        # fresh cfg.probe_timeout budget (see _evaluate_fen_impl), and reports
        # "unknown" for whatever's still unresolved once that budget passes.
        _evaluate_tls.bypass_parallel = prewarm_complete
        # Already built above (root_board, move_info) to size the progress
        # bar and know which child FENs to pre-warm — handing them to
        # evaluate_fen() here means a cache-miss FEN doesn't pay for a
        # second board build + legal-move walk right after this one.
        _evaluate_tls.board     = root_board
        _evaluate_tls.move_info = move_info
        try:
            json_str = evaluate_fen(variant, fen)
            yield 'data: {"status":"done",' + json_str[1:] + '\n\n'

        except Exception as e:
            yield _sse(_stream_error_payload(variant, fen, e))
        finally:
            _evaluate_tls.bypass_parallel = False
            _evaluate_tls.board     = None
            _evaluate_tls.move_info = None

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/health")
def health() -> Response:
    if TB is None:
        return jsonify({"status": "degraded", "reason": "Tablebase not initialised"}), 503
    return jsonify({"status": "ok"}), 200


def _cache_info_dict(info) -> dict:
    hits, misses       = info.hits, info.misses
    maxsize, currsize  = info.maxsize, info.currsize
    total = hits + misses
    return {
        "hits":     hits,
        "misses":   misses,
        "hit_rate": round(hits / total, 4) if total else 0.0,
        "maxsize":  maxsize,
        "currsize": currsize,
    }


@app.route("/admin/cache/clear", methods=["POST"])
@_require_admin
def clear_cache() -> Response:
    evaluate_fen.cache_clear()
    _probe_fen.cache_clear()
    # The two LRUs above are app.py-level caches keyed on (variant, FEN)
    # pairs. They are not the only cache in the probing pipeline: each tier's
    # underlying tablebase can keep its own internal decoded-block cache
    # and, in remote mode, a downloaded-file cache (remote/remote_fallback.py).
    # RoutedTablebase.clear_caches()/cache_stats() are exposed on TB
    # itself, but only actually clear/report something for a tier backed
    # by a remote/remote_fallback.py Tablebase -- a plain local-directory
    # Tablebase has no such cache. cache_stats() coming back empty is what
    # distinguishes "nothing to clear" from "cleared something", since
    # every tier is asked unconditionally either way.
    tb_cache_info: dict = {}
    if TB is not None:
        TB.clear_caches()
        tb_cache_info = TB.cache_stats()
    tb_cache_cleared = bool(tb_cache_info)
    log.info(
        "All probe caches cleared (tablebase-internal cache %s).",
        "cleared" if tb_cache_cleared else "not applicable for this tablebase",
    )
    response = {
        "status":             "ok",
        "message":            "All probe caches cleared (root JSON cache + child probe cache"
                               + (" + tablebase-internal caches)." if tb_cache_cleared else ")."),
        "evaluate_fen_cache": _cache_info_dict(evaluate_fen.cache_info()),
        "probe_fen_cache":    _cache_info_dict(_probe_fen.cache_info()),
        "tablebase_internal_cache_cleared": tb_cache_cleared,
    }
    if tb_cache_info:
        response["tablebase_cache"] = tb_cache_info
    return jsonify(response)


@app.route("/admin/cache/stats", methods=["GET"])
@_require_admin
def cache_stats() -> Response:
    stats = {
        "evaluate_fen_cache": _cache_info_dict(evaluate_fen.cache_info()),
        "probe_fen_cache":    _cache_info_dict(_probe_fen.cache_info()),
        "thread_pool": {
            "max_workers":        cfg.probe_threads,
            "parallel_threshold": cfg.parallel_threshold,
            "probe_timeout_secs": cfg.probe_timeout,
        },
        "config": {
            "evaluate_cache_size": cfg.evaluate_cache_size,
            "probe_cache_size":    cfg.probe_cache_size,
            "block_cache_bytes":   cfg.block_cache_bytes,
        },
        "tablebase": {
            "low_configured":       TB.low is not None if TB is not None else False,
            "high_configured":      TB.high is not None if TB is not None else False,
            "castling_configured":  TB.castling is not None if TB is not None else False,
        },
    }
    # RoutedTablebase.cache_stats() is exposed on TB and reports the configured tiers
    # -- a tier contributes no key when it has no remote-backed cache to
    # report (see clear_cache() above for why a plain local-directory
    # Tablebase has none).
    if TB is not None:
        tb_cache = TB.cache_stats()
        if tb_cache:
            stats["tablebase_cache"] = tb_cache
    return jsonify(stats)


@app.route("/admin/login", methods=["POST"])
@_admin_login_rate_limit
def admin_login() -> Response:
    if not cfg.admin_token:
        return jsonify({"error": "Admin panel disabled: ADMIN_TOKEN is not configured."}), 503
    body = request.get_json(silent=True) or {}
    token = body.get("token", "")
    if not isinstance(token, str) or not _admin_token_matches(token):
        return jsonify({"error": "Incorrect admin token."}), 401
    session["admin_ok"] = True
    return jsonify({"status": "ok"})


@app.route("/admin/logout", methods=["POST"])
def admin_logout() -> Response:
    session.pop("admin_ok", None)
    return jsonify({"status": "ok"})


@app.route("/admin", methods=["GET"])
def admin_dashboard() -> str | tuple[str, int]:
    # Renders the dashboard once authenticated (session cookie from
    # /admin/login); a login form otherwise. Unlike /admin/cache/* below,
    # this route can't just use _require_admin -- a browser visiting /admin
    # needs the login form itself, not a bare 401/503 JSON body. Matches
    # /admin/login and /admin/cache/*'s own 503 when ADMIN_TOKEN is unset,
    # rather than serving the dashboard shell with a 200.
    if not cfg.admin_token:
        return render_template(
            "admin.html", authenticated=False, admin_configured=False,
            github_url=cfg.github_url,
        ), 503
    return render_template(
        "admin.html",
        authenticated=_is_admin_authenticated(),
        admin_configured=True,
        github_url=cfg.github_url,
    )


# ── OpenAPI specification ─────────────────────────────────────────────────────
# Spec itself lives in openapi.yaml (project root) rather than as an inline
# string here -- keeps it out of app.py's line count and lets it be edited/
# linted/diffed as a normal YAML file.

_OPENAPI_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "openapi.yaml")


@app.route("/openapi.yaml")
def openapi_spec() -> Response:
    return send_file(_OPENAPI_PATH, mimetype="application/yaml")


if __name__ == "__main__":
    if cfg.debug:
        # Flask's own dev server: auto-reload + interactive debugger, for
        # local development only. `threaded=True` is what lets a long-lived
        # /probe/stream SSE connection coexist with other concurrent
        # requests on this single-process server (see README.md "Running in
        # production").
        log.info("DEBUG = True (config.py) — starting Flask development server on %s:%s", cfg.host, cfg.port)
        app.run(debug=True, host=cfg.host, port=cfg.port, threaded=True)
    else:
        # Production: serve via waitress, a pure-Python production-grade
        # WSGI server. `threads` gives waitress its own pool of
        # request-handling threads, playing the same role `threaded=True`
        # plays for the Flask dev server above — without it, a single
        # open /probe/stream connection could starve every other request
        # (see README.md "Running in production").
        #
        # trusted_proxy=* / trusted_proxy_count / trusted_proxy_headers:
        # waitress parses X-Forwarded-For and X-Forwarded-Proto and
        # rewrites REMOTE_ADDR / wsgi.url_scheme itself, *before* the
        # request ever reaches the Flask app object -- so it sits in front
        # of, and takes priority over, the ProxyFix layer wired onto
        # app.wsgi_app above. Without this, waitress's default
        # (trusted_proxy=None) strips both headers entirely as untrusted,
        # silently discarding them before ProxyFix could ever see them --
        # ProxyFix alone is not sufficient here. `"*"` trusts whichever
        # peer connects, rather than one specific IP, because Render's
        # edge/load-balancer's own address isn't a fixed, documented
        # value; this is safe under the same assumption
        # TRUSTED_PROXY_COUNT's docstring already states -- that nothing
        # but that one proxy hop can reach this process directly. Skipped
        # entirely when cfg.trusted_proxy_count is 0 (no reverse proxy in
        # front at all), leaving waitress's own default in place.
        log.info(
            "Starting waitress production server on %s:%s (threads=%s)",
            cfg.host, cfg.port, cfg.waitress_threads,
        )
        waitress_kwargs = {}
        if cfg.trusted_proxy_count > 0:
            waitress_kwargs.update(
                trusted_proxy="*",
                trusted_proxy_count=cfg.trusted_proxy_count,
                trusted_proxy_headers={"x-forwarded-for", "x-forwarded-proto"},
            )
        waitress_serve(
            app, host=cfg.host, port=cfg.port, threads=cfg.waitress_threads, **waitress_kwargs)