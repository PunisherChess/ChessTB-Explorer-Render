"""Remote (HTTP) ChessTB tablebase support for the standard
``chess.chesstb`` module (noobpwnftw's python-chess fork, see
requirements.txt) that app.py loads directly.

Why this exists
----------------
``chess.chesstb.Tablebase`` only ever reads from a local filesystem path:
``_TableFile._open_source()`` always resolves a real filesystem path with
``os.open()`` and memory-maps it (``mmap.mmap(..., access=mmap.ACCESS_READ)``),
and ``Tablebase._find()`` always resolves candidates with ``os.path.exists()``.
Neither can be pointed at a URL as they stand, and this module doesn't (and
can't, without vendoring/forking the pip package) modify them.

What this module does instead is subclass ``chess.chesstb.Tablebase`` and
override only the file-*resolution* step (``_find``): the first time a
probe touches a given material, the corresponding remote table file is
fetched in full and written to a local per-process cache directory, and
the resulting local path is handed unchanged to the standard, untouched
``WDLFile``/``DTZFile``/``DTCFile``/``DTMFile``/``DTM50File`` constructors --
which run completely unaware they're not reading from a hand-picked local
directory. Every
other behaviour (probing, index maths, block decoding, ``MissingTableError``,
the ``WIN``/``DRAW``/... constants, ``ProbeResult``) is the standard
module's own, unmodified implementation -- this module only changes *how a
table's bytes reach disk*, never what they mean once there.

A *whole* table file is downloaded the first time any position touches
that material, rather than only the specific byte ranges (header/index
plus whichever compressed blocks the position's index falls into) a probe
actually needs -- there's no way to get bytes in front of code that only
ever calls ``open()`` on a path other than putting real bytes at that
path first (see ``remote_direct.py`` for the byte-range alternative,
which reads through this module's ``RemoteFileView`` instead). Once
cached, later probes against that material are served straight
from local disk with no further network round trip. Concretely this
means: slower first touch of a given material (a full download instead
of a few small ranged fetches), fast disk-speed reads for everything
after, and real, if bounded and temporary, local disk usage. See
``_RemoteDiskCache`` below for the bound (``REMOTE_PAGE_CACHE_BYTES``
doing double duty as an on-disk budget here rather than an in-memory one)
and ``open_tablebase``/``Tablebase.close`` for the "temporary": the cache
lives in a fresh directory created per process and is removed when the
``Tablebase`` is closed (app.py does this at interpreter exit via
``atexit``, same as ``TB.close()``).

This module does not add any locking of its own around opening a
not-yet-seen remote material -- it only overrides ``_find``, and that
override runs from inside the base class's own ``_open_wdl``/``_open_dtz``/
``_open_dtc``/``_open_dtm``/``_open_dtm50``, each of which already guards
its whole open dance (including the ``_find`` call) with a per-*kind*
``threading.Lock`` and double-checked locking. So two threads racing to
probe the same never-before-seen material still collapse onto one
download here, inherited for free from the standard module's own
locking -- no extra work needed in this file. What that inherited lock
does *not* do is separate materials of the same kind from one another: it
is one lock per kind, shared by every material of that kind, so two
threads opening two *different* never-before-seen materials of the same
kind still serialize behind each other's round trip (a download, here,
rather than the cheap local ``os.path.exists()`` the base class was sized
for). That's a performance-only characteristic, not a correctness gap,
and is fine to leave as-is -- see remote_direct.py's module docstring for
the alternative (per-``(kind, material)`` locking) it uses instead.
"""
from __future__ import annotations

import collections
import importlib.util
import os
import shutil
import sys
import tempfile
import threading
from typing import Optional

import chess.chesstb as chesstb

__all__ = ["remote_source", "open_tablebase"]

#: sys.modules key shared with remote_direct.py's copy of
#: _load_remote_source_module(), so both backends resolve to the exact
#: same module instance -- and the same RemoteSourceError class -- instead
#: of two independently executed, class-incompatible copies of
#: remote_source.py.
_REMOTE_SOURCE_MODULE_NAME = "_chesstb_remote_source"


def _load_remote_source_module():
    """Load remote_source.py (this file's sibling in remote/) by path --
    this file itself is loaded directly by path by app.py (see its
    "ChessTB backend" section), not imported as part of a package, so a
    relative ``from . import remote_source`` isn't reliable here.
    """
    cached = sys.modules.get(_REMOTE_SOURCE_MODULE_NAME)
    if cached is not None:
        return cached
    this_dir = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(this_dir, "remote_source.py")
    spec = importlib.util.spec_from_file_location(_REMOTE_SOURCE_MODULE_NAME, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[_REMOTE_SOURCE_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


#: Re-exported so app.py can use remote_fallback.remote_source.looks_like_remote
#: / .RemoteSourceError.
remote_source = _load_remote_source_module()


class _RemoteDiskCache:
    """Soft-budgeted LRU of *whole downloaded table files* on local disk,
    keyed by the remote-relative path each was fetched from.

    Structurally mirrors one shard of :class:`remote_source._PageCache`
    one layer up the stack: same OrderedDict-as-LRU-ledger, same soft
    byte budget, same per-key lock so concurrent probe threads landing on
    the same not-yet-cached material download it once rather than once
    each -- just whole files here instead of fixed-size pages, since
    that's the unit the standard backend's file constructors can consume.

    A freshly recorded (or freshly touched, via ``has()``) entry always
    ends up at the *end* of the LRU order, and eviction always pops from
    the *front* -- so the file ``_find()`` just resolved a path for can
    never be the one an eviction happening on another thread picks next;
    only entries stale relative to it can be. That closes the same race
    :meth:`remote_source._PageCacheShard.put` avoids for in-memory pages: a
    long-untouched file could still be unlinked out from under a reader
    holding an OS-level file descriptor already open on it, but on POSIX
    an unlinked-but-open file stays readable to that descriptor until
    it's closed, so an in-flight ``open().read()`` (the only thing the
    standard ``WDLFile``/``DTZFile``/``DTCFile``/``DTMFile``/``DTM50File``
    ever do) is unaffected either way.
    """

    def __init__(self, root: str, max_bytes: int) -> None:
        self.root = root
        self.max_bytes = max_bytes
        self._sizes: "collections.OrderedDict[str, int]" = collections.OrderedDict()
        self._cur_bytes = 0
        self._lock = threading.Lock()
        self._entry_locks: dict[str, threading.Lock] = {}
        self._meta_lock = threading.Lock()
        # Guards the install-and-record tail of _ensure_cached() below
        # (the os.replace() + record() that actually mutates `root`'s
        # contents and this cache's bookkeeping together) against
        # clear()'s rmtree/recreate running at the same moment. A
        # per-entry lock (see lock_for()) already serializes concurrent
        # downloads of the *same* rel_path; this instead protects the
        # publish step against a whole-cache clear(). Reentrant because
        # clear() below nests other locks (_lock, _meta_lock) inside it.
        self.lifecycle_lock = threading.RLock()
        # Counts downloads that currently have an open, not-yet-published
        # temp file on disk. clear() waits for this to hit zero before
        # rmtree-ing `root` -- see begin_download()/end_download() and
        # clear() below for why: unlike lifecycle_lock, which only needs
        # to cover the brief publish step, a download's temp file is
        # vulnerable for its *entire* (potentially slow) transfer, not
        # just that tail. On POSIX, rmtree-ing a directory containing a
        # file that's still open only unlinks its name -- the data stays
        # readable/writable through the already-open descriptor -- but
        # once that descriptor closes (as it does at the end of
        # _ensure_cached()'s ``with open(tmp_path, "wb") as f:`` block,
        # before publish), an unlinked file's data is actually freed, so
        # the publish step's os.replace(tmp_path, ...) would fail with
        # FileNotFoundError for a *source* path that no longer exists
        # anywhere on disk. Deferring clear() instead of racing it avoids
        # that outright, and -- unlike holding lifecycle_lock for the
        # whole transfer -- doesn't serialize unrelated concurrent
        # downloads against each other, only against clear() itself.
        self._active_downloads = 0
        self._no_active_downloads = threading.Condition(self.lifecycle_lock)

    def begin_download(self) -> None:
        """Mark one download as having an in-flight temp file. Must be
        paired with a later :meth:`end_download`, typically via
        ``try/finally``."""
        with self.lifecycle_lock:
            self._active_downloads += 1

    def end_download(self) -> None:
        with self.lifecycle_lock:
            self._active_downloads -= 1
            if self._active_downloads <= 0:
                self._no_active_downloads.notify_all()

    def lock_for(self, rel_path: str) -> threading.Lock:
        lk = self._entry_locks.get(rel_path)
        if lk is not None:
            return lk
        with self._meta_lock:
            lk = self._entry_locks.get(rel_path)
            if lk is None:
                lk = threading.Lock()
                self._entry_locks[rel_path] = lk
            return lk

    def local_path(self, rel_path: str) -> str:
        return os.path.join(self.root, rel_path)

    def has(self, rel_path: str) -> bool:
        """True if `rel_path` is already cached on disk -- and, if so,
        mark it most-recently-used so a same-moment eviction on another
        thread can't pick it (see class docstring)."""
        with self._lock:
            if rel_path in self._sizes:
                self._sizes.move_to_end(rel_path)
                return True
        return False

    def record(self, rel_path: str, size: int) -> None:
        with self._lock:
            old = self._sizes.pop(rel_path, None)
            if old is not None:
                self._cur_bytes -= old
            self._sizes[rel_path] = size
            self._cur_bytes += size
            # Keep the just-added file (it's at the end); never evict fully
            # empty, mirroring remote_source._PageCacheShard.put / chesstb.py's
            # own _BlockCache.record.
            while self._cur_bytes > self.max_bytes and len(self._sizes) > 1:
                ev_path, ev_size = self._sizes.popitem(last=False)
                self._cur_bytes -= ev_size
                try:
                    os.remove(self.local_path(ev_path))
                except OSError:
                    pass

    def clear(self) -> None:
        with self.lifecycle_lock:
            while self._active_downloads > 0:
                self._no_active_downloads.wait()
            with self._lock:
                self._sizes.clear()
                self._cur_bytes = 0
            with self._meta_lock:
                self._entry_locks.clear()
            shutil.rmtree(self.root, ignore_errors=True)
            os.makedirs(self.root, exist_ok=True)

    def stats(self) -> dict:
        with self._lock:
            return {
                "cached_files": len(self._sizes),
                "cur_bytes":    self._cur_bytes,
                "max_bytes":    self.max_bytes,
            }


class _RemoteCachingTablebase(chesstb.Tablebase):
    """A standard ``chess.chesstb.Tablebase`` whose table files are
    fetched from a remote ``http(s)://`` base URL and disk-cached on
    first touch, rather than read from a local directory. See this
    module's docstring for the full design and trade-offs.
    """

    def __init__(self, base_url: str, *, block_cache_bytes: int,
                 remote_page_cache_bytes: int, remote_page_size: int,
                 remote_timeout: float, remote_max_retries: int,
                 remote_pool_maxsize: int) -> None:
        self._client = remote_source.RemoteHTTPClient(
            base_url, timeout=remote_timeout, max_retries=remote_max_retries,
            pool_maxsize=remote_pool_maxsize,
        )
        self._cache_root = tempfile.mkdtemp(prefix="chesstb_remote_cache_")
        self._disk_cache = _RemoteDiskCache(self._cache_root, remote_page_cache_bytes)
        self._download_chunk = remote_page_size
        self._size_cache: dict[str, Optional[int]] = {}
        self._size_lock = threading.Lock()
        # Base Tablebase.__init__ calls self.add_directory(base_url), which
        # joins `base_url` onto "wdl"/"dtz"/"dtc"/"dtm"/"dtm50" with
        # os.path.join and stashes the (unused here) results in self.dirs --
        # harmless, and left as-is rather than overridden, since _find below
        # never reads self.dirs for a remote table: it resolves directly
        # against "<kind>/" and never falls back to a bare-root candidate the
        # way local _find does -- the published remote layout always has the
        # kind subdirectories, per README.md's "Getting the tablebase
        # files").
        super().__init__(base_url, block_cache_bytes=block_cache_bytes)

    # --- table file resolution: fetch-and-cache-to-disk, then delegate ---

    def _find(self, kind: str, name: str, ext: str) -> Optional[str]:
        rel_path = f"{kind}/{name}{ext}"
        return self._ensure_cached(rel_path)

    def _remote_size(self, rel_path: str) -> Optional[int]:
        with self._size_lock:
            if rel_path in self._size_cache:
                return self._size_cache[rel_path]
        size = self._client.head_size(rel_path)  # may raise RemoteSourceError
        with self._size_lock:
            self._size_cache[rel_path] = size
        return size

    def _ensure_cached(self, rel_path: str) -> Optional[str]:
        if self._disk_cache.has(rel_path):
            return self._disk_cache.local_path(rel_path)
        with self._disk_cache.lock_for(rel_path):
            if self._disk_cache.has(rel_path):
                return self._disk_cache.local_path(rel_path)
            size = self._remote_size(rel_path)
            if size is None:
                return None
            local_path = self._disk_cache.local_path(rel_path)
            tmp_path = f"{local_path}.part"
            # begin_download()/end_download() make a concurrent
            # /admin/cache/clear() wait for this download rather than
            # racing it -- see _RemoteDiskCache's docstring on
            # _active_downloads for why racing it (rather than just
            # deferring) isn't safe to do here. This does NOT serialize
            # concurrent downloads of *different* tables against each
            # other -- only clear() waits, not other downloads -- so
            # probe concurrency (see config.py's PROBE_THREADS) is
            # unaffected; the per-path lock_for(rel_path) above already
            # prevents two threads from downloading the same rel_path at
            # once, which is the actual duplicate-work hazard here.
            self._disk_cache.begin_download()
            try:
                os.makedirs(os.path.dirname(local_path), exist_ok=True)
                try:
                    with open(tmp_path, "wb") as f:
                        offset = 0
                        while offset < size:
                            remaining = size - offset
                            chunk = self._client.get_range(
                                rel_path, offset, min(self._download_chunk, remaining)
                            )
                            if not chunk:
                                raise remote_source.RemoteSourceError(
                                    f"Incomplete download for {rel_path}: received "
                                    f"{offset} of {size} bytes"
                                )
                            if len(chunk) > remaining:
                                raise remote_source.RemoteSourceError(
                                    f"Oversized range response for {rel_path}: "
                                    f"{len(chunk)} bytes requested max {remaining}"
                                )
                            f.write(chunk)
                            offset += len(chunk)
                    # Publication -- the only part that actually needs
                    # `root` to still exist and mean what it did when this
                    # method started -- is what lifecycle_lock protects.
                    # Only reached once the loop above has written exactly
                    # `size` bytes -- an atomic rename protects
                    # visibility, not content correctness, so a short
                    # download must never reach this line.
                    with self._disk_cache.lifecycle_lock:
                        os.replace(tmp_path, local_path)
                        self._disk_cache.record(rel_path, size)
                except BaseException:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
                    raise
            finally:
                self._disk_cache.end_download()
            return local_path

    # --- lifecycle / admin surfaces (see app.py's clear_cache()/
    #     cache_stats(), both getattr-guarded so this stays optional) ---

    def close(self) -> None:
        try:
            super().close()
        finally:
            try:
                self._client.close()
            finally:
                shutil.rmtree(self._cache_root, ignore_errors=True)

    def clear_caches(self) -> None:
        """Drop the decoded-block cache and the on-disk downloaded-file
        cache, without forgetting which tables are open -- re-opening
        tables here would defeat the point of a cache-clear (a fresh
        Tablebase would just re-download everything on first touch)."""
        self._block_cache.clear()
        self._disk_cache.clear()

    def cache_stats(self) -> dict:
        blocks, block_bytes = len(self._block_cache._lru), self._block_cache.cur_bytes
        return {
            "block_cache_blocks": blocks,
            "block_cache_bytes":  block_bytes,
            "remote_disk_cache":  self._disk_cache.stats(),
            "remote_http":        self._client.stats(),
        }


def open_tablebase(directory: str, *,
                    block_cache_bytes: int = chesstb.DEFAULT_BLOCK_CACHE_BYTES,
                    remote_page_cache_bytes: int = remote_source.DEFAULT_PAGE_CACHE_BYTES,
                    remote_page_size: int = remote_source.DEFAULT_PAGE_SIZE,
                    remote_timeout: float = remote_source.DEFAULT_TIMEOUT,
                    remote_max_retries: int = remote_source.DEFAULT_MAX_RETRIES,
                    remote_pool_maxsize: int = remote_source.DEFAULT_POOL_MAXSIZE,
                    ) -> _RemoteCachingTablebase:
    """Open a remote ChessTB base URL against the standard
    ``chess.chesstb`` module. Same call signature as
    ``chess.chesstb.open_tablebase`` for a local path, so app.py can pick
    whichever this file's own docstring calls for based on
    ``TABLEBASE_PATH`` -- see that docstring for how the two differ under
    the hood.
    """
    return _RemoteCachingTablebase(
        directory,
        block_cache_bytes=block_cache_bytes,
        remote_page_cache_bytes=remote_page_cache_bytes,
        remote_page_size=remote_page_size,
        remote_timeout=remote_timeout,
        remote_max_retries=remote_max_retries,
        remote_pool_maxsize=remote_pool_maxsize,
    )
