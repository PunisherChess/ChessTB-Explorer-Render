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

RoutedTablebase below is what app.py opens as its single `TB` object. It
routes material lookup inside one upstream `chesstb.Tablebase`, so the
upstream prober's recursive dependency probes use the same low/high/castling
sources as the root probe. A 7- or 8-man table can therefore derive a
6-man child from TABLEBASE_PATH, and a castling-aware probe can resolve
ordinary child material through the appropriate piece-count tier.

TABLEBASE_PATH, TABLEBASE_PATH_7_8, and TABLEBASE_PATH_CASTLING each accept
either one path (a local directory or an http(s):// URL) or a list of
them. Entries are tried left-to-right within their selected tier. A list
mixing a local directory and a URL is a hybrid source.
"""
from __future__ import annotations

import logging
from typing import Any, List, Optional, Sequence, Union

import chess.chesstb as chesstb

from tablebase_opening import PerMaterialOpening

log = logging.getLogger(__name__)

#: Piece count (both kings included) at or under which a position uses the
#: low (<=6-men) tier rather than the high (7-8-men) tier.
SPLIT_PIECE_COUNT = 6

#: A tablebase-compatible source exposing probe()/close() and optionally
#: clear_caches()/cache_stats().
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
        remote_backend_name = cfg.remote_mode
        if remote_backend_name == "download":
            tb = remote_download.open_tablebase(
                path,
                block_cache_bytes=0,
                remote_page_cache_bytes=cfg.remote_page_cache_bytes,
                remote_page_size=cfg.remote_page_size_bytes,
                remote_timeout=cfg.remote_timeout_secs,
                remote_max_retries=cfg.remote_max_retries,
                remote_pool_maxsize=cfg.remote_pool_maxsize,
            )
        else:
            tb = remote_direct.open_tablebase(
                path,
                block_cache_bytes=0,
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
            0, cfg.remote_page_cache_bytes, cfg.remote_page_size_bytes,
        )
    else:
        tb = chesstb.open_tablebase(path, block_cache_bytes=0)
        log.info("%s opened at: %s (resolver block cache disabled)", label, path)
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
    sources: List[TablebaseLike] = []
    try:
        for i, p in enumerate(paths):
            sources.append(open_one(
                p, label=f"{label}[{i}]" if len(paths) > 1 else label,
                cfg=cfg, remote_source=remote_source,
                remote_direct=remote_direct, remote_download=remote_download,
            ))
    except Exception:
        # A later entry in a hybrid list failing to open must not leak
        # the sources earlier entries already opened.
        for source in sources:
            try:
                source.close()
            except Exception:
                log.exception("Failed closing partially opened source for %s", label)
        raise
    return sources[0] if len(sources) == 1 else CompositeTablebase(sources, remote_source=remote_source)


class _RemoteTableSource:
    __slots__ = ("remote_source", "file")

    def __init__(self, remote_source: Any, file: Any) -> None:
        self.remote_source = remote_source
        self.file = file


class _HybridSourced:
    def _open_source(self, path: Any) -> Any:
        if isinstance(path, _RemoteTableSource):
            self._data = path.file
            return path.remote_source.RemoteFileView(path.file)
        return super()._open_source(path)


class _HybridWDLFile(_HybridSourced, chesstb.WDLFile):
    pass


class _HybridDTZFile(_HybridSourced, chesstb.DTZFile):
    pass


class _HybridDTCFile(_HybridSourced, chesstb.DTCFile):
    pass


class _HybridDTMFile(_HybridSourced, chesstb.DTMFile):
    pass


class _HybridDTM50File(_HybridSourced, chesstb.DTM50File):
    pass



class CompositeTablebase:
    """A hybrid TABLEBASE_PATH entry: an ordered list of already-opened
    tablebase sources — any mix of a local chesstb.Tablebase and a
    remote_direct/remote_fallback backend — searched left-to-right until
    one resolves the material. Presents the same _find()/close()/
    clear_caches()/cache_stats() surface as a single chesstb.Tablebase,
    so RoutedTablebase and app.py's admin routes don't need to know
    whether a tier is backed by one source or several.

    A RemoteSourceError from one source (a network failure, not a "this
    material doesn't exist" answer) doesn't abort the walk — the next
    source is tried too, since resilience against exactly that is the
    point of listing more than one source. Only once every source has
    either answered "not found" or errored does _find() give up: it
    re-raises the last transport error if there was one — silently
    reporting "not found" instead would misrepresent a live network
    problem as a coverage gap — otherwise it returns None, the normal
    "position not covered" answer.
    """

    def __init__(self, sources: List[TablebaseLike], *, remote_source: Any) -> None:
        self._sources = sources
        self._remote_errors = (remote_source.RemoteSourceError,)

    def _find(self, kind: str, name: str, ext: str) -> Optional[Any]:
        last_error: Optional[BaseException] = None
        for source in self._sources:
            try:
                found = source._find(kind, name, ext)
            except self._remote_errors as exc:
                last_error = exc
                continue
            if found is not None:
                return found
        if last_error is not None:
            raise last_error
        return None

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


class RoutedTablebase(PerMaterialOpening, chesstb.Tablebase):
    """A single upstream-compatible tablebase with tier-aware material lookup."""

    WDL_FILE = _HybridWDLFile
    DTZ_FILE = _HybridDTZFile
    DTC_FILE = _HybridDTCFile
    DTM_FILE = _HybridDTMFile
    DTM50_FILE = _HybridDTM50File

    def __init__(self, low: Optional[TablebaseLike], high: Optional[TablebaseLike],
                 castling: Optional[TablebaseLike], *, remote_source: Any,
                 block_cache_bytes: int) -> None:
        self.low = low
        self.high = high
        self.castling = castling
        self._remote_source = remote_source
        # A disk-cache resolver returns a pathname before the file is mapped.
        # Do not increase its open concurrency without a separate file-lease
        # design protecting that gap against eviction. Direct HTTP handles
        # and ordinary local files do not have that temporary-path lifetime.
        def uses_download(source: Any) -> bool:
            if isinstance(source, CompositeTablebase):
                return any(uses_download(s) for s in source._sources)
            return "_disk_cache" in getattr(source, "__dict__", {})

        self._serialize_downloads = any(uses_download(s) for s in (low, high, castling))
        super().__init__("", block_cache_bytes=block_cache_bytes)

    def _table_open_lock(self, kind: str, cache_key: Any) -> Any:
        if self._serialize_downloads:
            return self._open_locks[kind]
        return super()._table_open_lock(kind, cache_key)

    @staticmethod
    def _piece_count_from_name(name: str) -> int:
        # The pair is spelled once on each side (KpKp = four men): each
        # lowercase p is one physical pawn, each lowercase r one castling rook.
        return sum(ch.isupper() for ch in name) + name.count("p") + name.count("r")

    def _sources_for_material(self, name: str) -> Optional[TablebaseLike]:
        if "r" in name and self.castling is not None:
            return self.castling
        piece_count = self._piece_count_from_name(name)
        if piece_count > SPLIT_PIECE_COUNT and self.high is not None:
            return self.high
        return self.low

    def _find(self, kind: str, name: str, ext: str) -> Optional[Any]:
        source = self._sources_for_material(name)
        if source is None:
            return None
        found = source._find(kind, name, ext)
        if found is None:
            return None
        if isinstance(found, str):
            return found
        if isinstance(found, _RemoteTableSource):
            return found
        return _RemoteTableSource(self._remote_source, found)

    def close(self) -> None:
        try:
            super().close()
        finally:
            for source in (self.castling, self.high, self.low):
                if source is not None:
                    source.close()

    def clear_caches(self) -> None:
        self._block_cache.clear()
        for source in (self.castling, self.high, self.low):
            if source is not None:
                clear_fn = getattr(source, "clear_caches", None)
                if clear_fn is not None:
                    clear_fn()

    def cache_stats(self) -> dict:
        stats = {"router_block_cache": {
            "blocks": len(self._block_cache._lru),
            "bytes": self._block_cache.cur_bytes,
        }}
        for name, source in (("low", self.low), ("high", self.high), ("castling", self.castling)):
            if source is not None:
                stats_fn = getattr(source, "cache_stats", None)
                if stats_fn is not None:
                    stats[name] = stats_fn()
        return stats

