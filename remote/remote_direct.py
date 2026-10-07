"""Byte-range ChessTB tablebase access: probe remote tables in place,
fetching only the bytes each probe touches.

How this differs from remote_fallback.py
----------------------------------------
remote_fallback.py downloads a whole table file on first touch and hands
the standard ``WDLFile``/``DTZFile``/``DTCFile``/``DTMFile``/``DTM50File``
a local path. This module instead resolves a material to a
:class:`remote_source.RemoteFile` without downloading it.
tablebase_router's file classes read it through
:class:`remote_source.RemoteFileView` by overriding
``chess.chesstb._TableFile._open_source``, the upstream seam for reading
through any buffer-shaped object. The table's header parse plus each
probe's block reads pull only their own byte ranges through the shared page
cache. A material's first touch fetches its existence, size, and first page
together in one round trip (see ``_remote_size`` /
:meth:`remote_source.RemoteHTTPClient.get_first_page`) and seeds the page
cache with it, since the header parse that runs immediately afterward needs
exactly that page next anyway.

Trade-off against remote_fallback.py
------------------------------------
Cold cost is "a handful of 256 KiB pages" rather than "one full table
download", and ``REMOTE_PAGE_CACHE_BYTES`` bounds memory only -- nothing
is written to disk here at all.

The cost is per-read CPU. Against a mapping, the hot 8-byte bit-window
read (:func:`chess.chesstb._read_u64le`) is a C-level ``unpack_from``;
here every one of them is a Python call into
:meth:`remote_source.RemoteFile.read` -> a dict lookup and a slice, even
on a page-cache hit. So this backend wins decisively while a session
ranges over many materials (the common case for an explorer: most tables
are touched a few times each) and loses to remote_fallback.py once a
single material is probed hard enough that the download amortizes.
config.py's ``REMOTE_MODE`` selects between them.

Per-material opening
--------------------
``RoutedTablebase`` locks first opens per ``(kind, material)`` (see
tablebase_opening.py), so the network round trip in ``_find`` for one
material does not block another material of the same kind.
"""
from __future__ import annotations

import threading
from typing import Any, Dict, Optional

import chess.chesstb as chesstb

from tablebase_opening import block_cache_usage

from . import remote_source

__all__ = ["open_tablebase"]


class _RemoteTablebase(chesstb.Tablebase):
    """Resolves tables to HTTP byte-range handles for ``RoutedTablebase``;
    it is not probed itself.
    """

    def __init__(self, base_url: str, *, block_cache_bytes: int,
                 remote_page_cache_bytes: int, remote_page_size: int,
                 remote_timeout: float, remote_max_retries: int,
                 remote_pool_maxsize: int) -> None:
        self._client = remote_source.RemoteHTTPClient(
            base_url, timeout=remote_timeout, max_retries=remote_max_retries,
            pool_maxsize=remote_pool_maxsize,
        )
        # One page cache for every table opened against this base URL, so a
        # material's index region stays resident once touched and the budget
        # is enforced across materials rather than per table, split evenly
        # across the cache's shards.
        self._page_cache = remote_source._PageCache(remote_page_cache_bytes)
        self._page_size = remote_page_size
        # A cached None means "asked, no such table" -- same contract as the
        # open caches upstream keeps, so a missing material costs one HEAD
        # for the session rather than one per probe.
        self._sizes: Dict[str, Optional[int]] = {}
        self._size_lock = threading.Lock()
        super().__init__(base_url, block_cache_bytes=block_cache_bytes)

    def add_directory(self, base_dir: str) -> None:
        """No-op. The base class's version os.path.joins kind
        subdirectories onto ``base_dir`` and stashes the result in
        ``self.dirs`` for ``_find`` to search -- this subclass's own
        ``_find`` below builds ``"<kind>/<name><ext>"`` relative to the
        remote base URL directly and never consults ``self.dirs``."""

    # --- table resolution: a handle, not a download ---

    def _find(self, kind: str, name: str, ext: str) -> Optional[Any]:
        rel_path = f"{kind}/{name}{ext}"
        size = self._remote_size(rel_path)
        if size is None:
            return None
        return remote_source.RemoteFile(
            self._client, rel_path, size, self._page_cache, self._page_size,
        )

    def _remote_size(self, rel_path: str) -> Optional[int]:
        with self._size_lock:
            if rel_path in self._sizes:
                return self._sizes[rel_path]
        # First touch of this material (always under RoutedTablebase's
        # per-(kind, material) lock, see tablebase_opening.py): one ranged
        # GET for page 0 answers "does it exist", "how big is it", and
        # "here's its header" together, since the header parse about to run
        # needs exactly this page next anyway. The same response supplies
        # the existence, size, and initial table bytes needed by the caller.
        size, data = self._client.get_first_page(rel_path, self._page_size)
        with self._size_lock:
            self._sizes[rel_path] = size
        if size is not None and data:
            self._page_cache.put((rel_path, 0), data)
        return size

    # --- lifecycle / admin surfaces (RoutedTablebase reaches these via
    #     getattr) ---

    def close(self) -> None:
        try:
            super().close()
        finally:
            # Runs after RoutedTablebase.close() has drained in-flight
            # probes and released every table's view. Nested try/finally
            # so the connection pool is still released even if clearing
            # the page cache raises.
            try:
                self._page_cache.clear()
            finally:
                self._client.close()

    def clear_caches(self) -> None:
        """Drop decoded blocks and fetched pages, keeping open tables open
        -- reopening would only re-fetch the same headers immediately."""
        self._block_cache.clear()
        self._page_cache.clear()

    def cache_stats(self) -> Dict[str, Any]:
        page_hits, page_misses = self._page_cache.hits, self._page_cache.misses
        page_total = page_hits + page_misses
        blocks, size = block_cache_usage(self)
        return {
            "block_cache_blocks": blocks,
            "block_cache_bytes":  size,
            "remote_page_cache": {
                "pages":     self._page_cache.page_count,
                "cur_bytes": self._page_cache.cur_bytes,
                "max_bytes": self._page_cache.max_bytes,
                "page_size": self._page_size,
                "hits":      page_hits,
                "misses":    page_misses,
                "hit_rate":  round(page_hits / page_total, 4) if page_total else 0.0,
            },
            "remote_http": self._client.stats(),
            "materials_resolved": sum(1 for v in self._sizes.values() if v is not None),
        }


def open_tablebase(directory: str, *,
                   block_cache_bytes: int = chesstb.DEFAULT_BLOCK_CACHE_BYTES,
                   remote_page_cache_bytes: int = remote_source.DEFAULT_PAGE_CACHE_BYTES,
                   remote_page_size: int = remote_source.DEFAULT_PAGE_SIZE,
                   remote_timeout: float = remote_source.DEFAULT_TIMEOUT,
                   remote_max_retries: int = remote_source.DEFAULT_MAX_RETRIES,
                   remote_pool_maxsize: int = remote_source.DEFAULT_POOL_MAXSIZE,
                   ) -> _RemoteTablebase:
    """Open a remote ChessTB base URL, reading tables in place over byte
    ranges. Signature-compatible with ``remote_fallback.open_tablebase``,
    so tablebase_router.open_one selects either without special-casing.
    """
    return _RemoteTablebase(
        directory,
        block_cache_bytes=block_cache_bytes,
        remote_page_cache_bytes=remote_page_cache_bytes,
        remote_page_size=remote_page_size,
        remote_timeout=remote_timeout,
        remote_max_retries=remote_max_retries,
        remote_pool_maxsize=remote_pool_maxsize,
    )
