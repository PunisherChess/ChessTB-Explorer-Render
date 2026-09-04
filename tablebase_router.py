"""tablebase_router.py — TABLEBASE_PATH routing by piece count and by
castling rights.

ChessTB ships two practically distinct table sets: everything with 6 or
fewer men on the board, and the much larger 7-and-8-men set generated on
top of it. Deployments commonly keep the two apart — 6-men tables are
small enough to mirror locally without much thought, while 7-and-8-men
tables run into the terabytes and are more often served remotely, kept
only partially on disk, or split across a local cache plus a remote
source for whatever hasn't been fetched yet. config.py exposes this as
two independent settings, TABLEBASE_PATH (6-men and under) and
TABLEBASE_PATH_7_8 (7 and 8 men).

Separately, a position where a king or rook retains a still-usable
castling right is answered by a *different* table than the same material
without that right (chess.chesstb names it with a lowercase "r" — see
specialized_config_from_board() in chess.chesstb — and a rights-bearing
position is only ever resolved by that table, never by the plain one).
ChessTB publishes this castling-aware set under one more path, again
independent of piece count. config.py exposes it as TABLEBASE_PATH_CASTLING.

TieredTablebase below is what app.py opens as its single `TB` object: it
holds one already-opened tablebase source per path and routes every
probe()/close()/clear_caches()/cache_stats() call by inspecting the
*board actually being probed* — chess.Board.clean_castling_rights()
picks TABLEBASE_PATH_CASTLING when it's configured, regardless of piece
count; otherwise SPLIT_PIECE_COUNT picks TABLEBASE_PATH or
TABLEBASE_PATH_7_8, with a castling-rights position falling through to
this same piece-count selection whenever TABLEBASE_PATH_CASTLING isn't
configured, the same way TABLEBASE_PATH_7_8 falls back to TABLEBASE_PATH
when it isn't.

Routing happens per probe, not per request, which matters once a capture
is involved: app.py probes a root FEN and then, independently, every
legal move's resulting child FEN (see evaluate_all_moves() in app.py). A
capture removes a piece, so a root position with 7 men can have a child
position with 6 — TieredTablebase.probe() reads the piece count (and
castling rights) off whichever chess.Board it's actually handed, so the
root and that child probe correctly through whichever of the three paths
each actually needs within the same /probe request, with no
special-casing needed anywhere in app.py's move-ranking code. The same
applies to a move that gives up a castling right without a capture (a
king or rook moving off its home square): the child position simply
isn't castling-rights-bearing any more, so it routes by piece count like
any other position.

CompositeTablebase below is the other half: TABLEBASE_PATH,
TABLEBASE_PATH_7_8, and TABLEBASE_PATH_CASTLING each accept either one
path (a local directory or an http(s):// URL) or a list of them, tried
left-to-right until one has the material being probed. A list mixing a
local directory and a URL is a "hybrid" source — typically a partial
local mirror of that path's most-probed materials, backed by a remote
URL for whatever else the position needs.
"""
from __future__ import annotations

import logging
from typing import Any, List, Optional, Sequence, Union

import chess
import chess.chesstb as chesstb

log = logging.getLogger(__name__)

#: Piece count (both kings included) at or under which a position routes
#: through the "low" (<=6-men) tier rather than "high" (7-8-men) — see
#: TieredTablebase._select(). This is the boundary ChessTB itself
#: generates along (its 7-and-8-men tables are a distinct, much larger
#: pass over the 6-men set), not a deployment preference, so it isn't a
#: config.py setting.
SPLIT_PIECE_COUNT = 6

#: A chesstb.Tablebase, a remote_direct._RemoteTablebase, a
#: remote_fallback._RemoteCachingTablebase, or a CompositeTablebase
#: wrapping any mix of those — anything with probe()/close() and
#: optionally clear_caches()/cache_stats().
TablebaseLike = Any

#: A TABLEBASE_PATH / TABLEBASE_PATH_7_8 / TABLEBASE_PATH_CASTLING config
#: value: one path (local directory or http(s):// URL), or a list of
#: them for a hybrid source.
PathSpec = Union[str, Sequence[str]]


def _as_path_list(spec: PathSpec) -> List[str]:
    """Normalises a PathSpec to a flat list of non-empty path strings."""
    paths = [spec] if isinstance(spec, str) else list(spec)
    return [p for p in paths if p]


def open_one(path: str, *, label: str, cfg: Any, remote_source: Any,
             remote_direct: Any, remote_download: Any) -> TablebaseLike:
    """Opens a single local-directory or http(s):// `path`, choosing
    between the two remote backends. Factored out so open_many() below
    can call it once per hybrid-source entry and once per tier.

    `label` names the path in log lines only (e.g. "TABLEBASE_PATH" or
    "TABLEBASE_PATH_7_8[1]"), so a multi-source, multi-tier startup log
    stays attributable to the setting that produced each line.
    """
    if remote_source.looks_like_remote(path):
        remote_backend_name = (
            "direct" if cfg.remote_mode == "direct" and remote_direct.seam_available()
            else "download")
        if remote_backend_name == "download":
            if cfg.remote_mode == "direct":
                log.warning(
                    "%s: REMOTE_MODE is \"direct\", but the installed chess.chesstb has no "
                    "table-source seam (Tablebase.WDL_FILE / _TableFile._open_source) -- "
                    "using \"download\" instead. Update the fork (see requirements.txt) "
                    "to get byte-range probing.", label)
            tb = remote_download.open_tablebase(
                path,
                block_cache_bytes=cfg.block_cache_bytes,
                remote_page_cache_bytes=cfg.remote_page_cache_bytes,
                remote_page_size=cfg.remote_page_size_bytes,
                remote_timeout=cfg.remote_timeout_secs,
                remote_max_retries=cfg.remote_max_retries,
                remote_pool_maxsize=cfg.remote_pool_maxsize,
            )
        else:
            tb = remote_direct.open_tablebase(
                path,
                block_cache_bytes=cfg.block_cache_bytes,
                remote_page_cache_bytes=cfg.remote_page_cache_bytes,
                remote_page_size=cfg.remote_page_size_bytes,
                remote_timeout=cfg.remote_timeout_secs,
                remote_max_retries=cfg.remote_max_retries,
                remote_pool_maxsize=cfg.remote_pool_maxsize,
            )
        log.info(
            "%s opened remotely at: %s (mode=%s, %s, block_cache_bytes=%d, "
            "remote_page_cache_bytes=%d, remote_page_size=%d)",
            label, path, remote_backend_name,
            "byte-range, nothing written to disk" if remote_backend_name == "direct"
            else "whole-file download, disk-cached",
            cfg.block_cache_bytes, cfg.remote_page_cache_bytes, cfg.remote_page_size_bytes,
        )
    else:
        tb = chesstb.open_tablebase(path, block_cache_bytes=cfg.block_cache_bytes)
        log.info("%s opened at: %s (block_cache_bytes=%d)", label, path, cfg.block_cache_bytes)
    return tb


def open_many(spec: PathSpec, *, label: str, cfg: Any, remote_source: Any,
              remote_direct: Any, remote_download: Any) -> Optional[TablebaseLike]:
    """Opens a TABLEBASE_PATH-style config value `spec` (TABLEBASE_PATH,
    TABLEBASE_PATH_7_8, or TABLEBASE_PATH_CASTLING) — one path or a
    hybrid list of them — returning a single already-opened tablebase
    (wrapped in CompositeTablebase when `spec` has more than one entry),
    or None if `spec` has no usable entries."""
    paths = _as_path_list(spec)
    if not paths:
        return None
    sources = [
        open_one(
            p, label=f"{label}[{i}]" if len(paths) > 1 else label,
            cfg=cfg, remote_source=remote_source,
            remote_direct=remote_direct, remote_download=remote_download,
        )
        for i, p in enumerate(paths)
    ]
    return sources[0] if len(sources) == 1 else CompositeTablebase(sources, remote_source=remote_source)


class CompositeTablebase:
    """A hybrid TABLEBASE_PATH entry: an ordered list of already-opened
    tablebase sources — any mix of a local chesstb.Tablebase and a
    remote_direct/remote_fallback backend — probed left-to-right until
    one resolves the position. Presents the same probe()/close()/
    clear_caches()/cache_stats() surface as a single chesstb.Tablebase,
    so TieredTablebase and app.py's admin routes don't need to know
    whether a tier is backed by one source or several.

    A RemoteSourceError from one source (a network failure, not a "this
    material doesn't exist" answer) doesn't abort the walk — the next
    source is tried too, since resilience against exactly that is the
    point of listing more than one source. Only once every source has
    either answered "not found" or errored does probe() give up: it
    re-raises the last transport error if there was one — silently
    reporting "not found" instead would misrepresent a live network
    problem as a coverage gap — otherwise it returns the last
    "tb_not_found" ProbeResult, the normal "position not covered" answer.
    """

    def __init__(self, sources: List[TablebaseLike], *, remote_source: Any) -> None:
        self._sources = sources
        self._remote_errors = (remote_source.RemoteSourceError,)

    def probe(self, board: "chess.Board", rule50: int = 0) -> "chesstb.ProbeResult":
        result = chesstb.ProbeResult()
        last_error: Optional[BaseException] = None
        for source in self._sources:
            try:
                result = source.probe(board, rule50=rule50)
            except self._remote_errors as exc:
                last_error = exc
                continue
            if result.status == "ok":
                return result
        if last_error is not None:
            raise last_error
        return result

    def close(self) -> None:
        for source in self._sources:
            source.close()

    def clear_caches(self) -> None:
        for source in self._sources:
            clear_fn = getattr(source, "clear_caches", None)
            if clear_fn is not None:
                clear_fn()

    def cache_stats(self) -> dict:
        """Per-source cache stats, keyed "source_0", "source_1", ... in
        list order — a source with no cache of its own (a plain local
        chesstb.Tablebase) contributes no key rather than an empty one."""
        stats = {}
        for i, source in enumerate(self._sources):
            stats_fn = getattr(source, "cache_stats", None)
            if stats_fn is not None:
                stats[f"source_{i}"] = stats_fn()
        return stats


class TieredTablebase:
    """app.py's single `TB` object once TABLEBASE_PATH is split by piece
    count and by castling rights. Wraps one already-opened tablebase per
    path and routes every probe() by inspecting the *board being probed*
    — see the module docstring for why that's the board handed to
    probe(), not the request's root position.

    A position with a usable castling right (chess.Board.
    clean_castling_rights()) routes to `castling` when TABLEBASE_PATH_CASTLING
    is configured — chess.chesstb resolves such a position only from the
    castling-aware ("...r..." named) table, so trying `low`/`high` first
    would always miss (see _route_specialized() in chess.chesstb). Left
    unconfigured, `castling` is None and a castling-rights-bearing
    position instead falls through to the same piece-count selection as
    any other position, on the chance the low/high directory happens to
    carry the castling-aware files too; failing that it resolves to the
    normal "not covered" answer.

    `high` is None when TABLEBASE_PATH_7_8 isn't configured, in which
    case every piece count — 7 and 8 included — routes through `low`,
    matching a single combined tablebase directory that already covers
    up to 8 men. `low` is None only when TABLEBASE_PATH itself isn't
    configured — the only one of the three settings app.py requires (see
    app.py's startup section) — rather than constructing a
    TieredTablebase with nothing behind it.
    """

    def __init__(self, low: Optional[TablebaseLike], high: Optional[TablebaseLike],
                 castling: Optional[TablebaseLike] = None,
                 *, split_piece_count: int = SPLIT_PIECE_COUNT) -> None:
        self.low = low
        self.high = high
        self.castling = castling
        self._split = split_piece_count

    def _select(self, board: "chess.Board") -> Optional[TablebaseLike]:
        piece_count = chess.popcount(board.occupied)
        if piece_count > self._split and self.high is not None:
            return self.high
        return self.low

    def probe(self, board: "chess.Board", rule50: int = 0) -> "chesstb.ProbeResult":
        if board.clean_castling_rights() and self.castling is not None:
            backend = self.castling
        else:
            backend = self._select(board)
        if backend is None:
            return chesstb.ProbeResult()
        return backend.probe(board, rule50=rule50)

    def _tiers(self):
        """Unique (name, backend) pairs, skipping a path left at None
        (not every deployment configures all three) — close()/
        clear_caches()/cache_stats() below only ever touch a path that's
        actually open."""
        seen_ids = set()
        tiers = []
        for name, backend in (("low", self.low), ("high", self.high), ("castling", self.castling)):
            if backend is None or id(backend) in seen_ids:
                continue
            seen_ids.add(id(backend))
            tiers.append((name, backend))
        return tiers

    def close(self) -> None:
        for _, backend in self._tiers():
            backend.close()

    def clear_caches(self) -> None:
        for _, backend in self._tiers():
            clear_fn = getattr(backend, "clear_caches", None)
            if clear_fn is not None:
                clear_fn()

    def cache_stats(self) -> dict:
        """Per-path cache stats, keyed "low"/"high"/"castling" — a path
        backed entirely by local directories contributes no key, matching
        CompositeTablebase.cache_stats()."""
        stats = {}
        for name, backend in self._tiers():
            stats_fn = getattr(backend, "cache_stats", None)
            if stats_fn is not None:
                stats[name] = stats_fn()
        return stats
