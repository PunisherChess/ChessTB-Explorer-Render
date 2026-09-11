"""Shared transport opening policy; all table decoding/probing stays upstream.

The router resolves through a source's _find(), not its _open_*() methods.
Consequently per-material locking must live on the tablebase which actually
owns the opened files. Keep this one small copy of upstream's double-checked
open contract for both routed and standalone HTTP probes.
"""
from __future__ import annotations

import threading
from typing import Any
import weakref


class PerMaterialOpening:
    """Mixin for chesstb.Tablebase with independent first opens per material.

    Upstream probe() registers readers around the entire recursive walk;
    its close() drains them before closing the caches. No probing logic or
    lifecycle override is needed here. As upstream, direct calls to private
    _open_* methods must not race close().
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._material_locks: weakref.WeakValueDictionary = weakref.WeakValueDictionary()
        self._material_locks_meta_lock = threading.Lock()
        super().__init__(*args, **kwargs)

    def _material_lock(self, kind: str, cache_key: Any) -> Any:
        # A caller's context manager holds a strong reference while waiting
        # and while owning the lock. Unused lock objects can then disappear,
        # without deleting a lock another thread may still be waiting on.
        with self._material_locks_meta_lock:
            key = (kind, cache_key)
            lock = self._material_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._material_locks[key] = lock
            return lock

    def _table_open_lock(self, kind: str, cache_key: Any) -> Any:
        return self._material_lock(kind, cache_key)

    def _open_any(self, kind: str, cache: dict, file_cls: Any, cfg: Any) -> Any:
        key = cfg.cache_key
        try:
            return cache[key]
        except KeyError:
            pass
        with self._table_open_lock(kind, key):
            try:
                return cache[key]
            except KeyError:
                pass
            path = self._find(kind, cfg.name(), file_cls.EXT)
            table = file_cls(cfg, path, self._block_cache) if path is not None else None
            # Cache genuine absence, but never cache a transport/parse error.
            cache[key] = table
            return table

    def _open_wdl(self, cfg: Any) -> Any:
        return self._open_any("wdl", self._wdl_cache, self.WDL_FILE, cfg)

    def _open_dtz(self, cfg: Any) -> Any:
        return self._open_any("dtz", self._dtz_cache, self.DTZ_FILE, cfg)

    def _open_dtc(self, cfg: Any) -> Any:
        return self._open_any("dtc", self._dtc_cache, self.DTC_FILE, cfg)

    def _open_dtm(self, cfg: Any) -> Any:
        return self._open_any("dtm", self._dtm_cache, self.DTM_FILE, cfg)

    def _open_dtm50(self, cfg: Any) -> Any:
        return self._open_any("dtm50", self._dtm50_cache, self.DTM50_FILE, cfg)
