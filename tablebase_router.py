"""tablebase_router.py: ordered TABLEBASE_PATH source resolution.

TABLEBASE_PATH accepts either one path (a local directory or an http(s)://
URL) or a list of them. Entries are tried left-to-right for every material.
A list mixing a local directory and a URL is a hybrid source.

SourcedTablebase below is what app.py opens as its single `TB` object. It
resolves material lookup inside one upstream `chesstb.Tablebase`, so the
upstream prober's recursive dependency probes use the same source order as
the root probe.
"""
from __future__ import annotations

import logging
from typing import Any, List, Optional, Sequence, Union

import chess.chesstb as chesstb

from tablebase_opening import PerMaterialOpening, block_cache_usage

log = logging.getLogger(__name__)

#: A source exposing _find()/close() and optionally clear_caches()/
#: cache_stats().
TablebaseLike = Any

#: A TABLEBASE_PATH config value: one path (local directory or http(s)://
#: URL), or a list of them for a hybrid source.
PathSpec = Union[str, Sequence[str]]


def _as_path_list(spec: PathSpec) -> List[str]:
    """Normalises a PathSpec to a flat list of non-empty path strings."""
    paths = [spec] if isinstance(spec, str) else list(spec)
    return [p for p in paths if p]


def open_one(path: str, *, label: str, cfg: Any, remote_source: Any,
             remote_direct: Any, remote_download: Any) -> TablebaseLike:
    """Opens a single local-directory or http(s):// `path`, choosing
    between the two remote backends. open_many() calls it once per
    hybrid-source entry.

    `label` names the path in log lines only (e.g. "TABLEBASE_PATH" or
    "TABLEBASE_PATH[1]"), so a multi-source startup log stays attributable
    to the entry that produced each line.
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
    """Opens the TABLEBASE_PATH config value `spec` - one path or a
    hybrid list of them - returning a single already-opened tablebase
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
            # Upstream's _open_source contract: _TableFile.close() releases
            # _data. RemoteFile.close() is intentionally a no-op.
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
    tablebase sources - any mix of a local chesstb.Tablebase and a
    remote_direct/remote_fallback backend - searched left-to-right until
    one resolves the material. Presents the same _find()/close()/
    clear_caches()/cache_stats() surface as a single chesstb.Tablebase,
    so SourcedTablebase and app.py's admin routes don't need to know
    whether the resolver uses one source or several.

    A RemoteSourceError from one source (a network failure, not a "this
    material doesn't exist" answer) doesn't abort the walk - the next
    source is tried too, since resilience against exactly that is the
    point of listing more than one source. Only once every source has
    either answered "not found" or errored does _find() give up: it
    re-raises the last transport error if there was one - silently
    reporting "not found" instead would misrepresent a live network
    problem as a coverage gap - otherwise it returns None, the normal
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
        list order - a source with no cache of its own (a plain local
        chesstb.Tablebase) contributes no key rather than an empty one."""
        stats = {}
        for i, source in enumerate(self._sources):
            stats_fn = getattr(source, "cache_stats", None)
            if stats_fn is not None:
                stats[f"source_{i}"] = stats_fn()
        return stats


class SourcedTablebase(PerMaterialOpening, chesstb.Tablebase):
    """A single upstream-compatible tablebase backed by one ordered resolver."""

    WDL_FILE = _HybridWDLFile
    DTZ_FILE = _HybridDTZFile
    DTC_FILE = _HybridDTCFile
    DTM_FILE = _HybridDTMFile
    DTM50_FILE = _HybridDTM50File

    def __init__(self, source: TablebaseLike, *, remote_source: Any,
                 block_cache_bytes: int) -> None:
        self.source = source
        self._remote_source = remote_source
        # A disk-cache resolver returns a pathname before the file is mapped.
        # Do not increase its open concurrency without a separate file-lease
        # design protecting that gap against eviction. Direct HTTP handles
        # and ordinary local files do not have that temporary-path lifetime.
        def uses_download(source: Any) -> bool:
            if isinstance(source, CompositeTablebase):
                return any(uses_download(s) for s in source._sources)
            return "_disk_cache" in getattr(source, "__dict__", {})

        self._serialize_downloads = uses_download(source)
        super().__init__("", block_cache_bytes=block_cache_bytes)

    def add_directory(self, directory: str) -> None:
        """No-op: material lookup goes through the ordered source resolver."""

    def _table_open_lock(self, kind: str, cache_key: Any) -> Any:
        # _open_locks is upstream's per-kind first-open lock table.
        if self._serialize_downloads:
            return self._open_locks[kind]
        return super()._table_open_lock(kind, cache_key)

    def _find(self, kind: str, name: str, ext: str) -> Optional[Any]:
        found = self.source._find(kind, name, ext)
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
            self.source.close()

    def clear_caches(self) -> None:
        self._block_cache.clear()
        clear_fn = getattr(self.source, "clear_caches", None)
        if clear_fn is not None:
            clear_fn()

    def cache_stats(self) -> dict:
        blocks, size = block_cache_usage(self)
        stats = {"block_cache": {"blocks": blocks, "bytes": size}}
        stats_fn = getattr(self.source, "cache_stats", None)
        if stats_fn is not None:
            stats["source"] = stats_fn()
        return stats

