"""Resolves rounded DTZ values by cross-checking a position's moves.

A rounded DTZ stands for a few candidate values. The root's DTZ is the best
value among the moves that keep its class (smallest when winning, largest
when losing), so root candidates that no consistent set of move values can
produce are discarded, and a move that must supply the root's value is pinned.
"""

from __future__ import annotations

import operator
from typing import NamedTuple, Sequence


class MoveOption(NamedTuple):
    child: tuple[int, ...]  # candidate DTZ values of the position after the move
    value: tuple[int, ...]  # the move's DTZ for each candidate in `child`


class Resolution(NamedTuple):
    root: int | None  # exact root DTZ, or None when it cannot be determined
    pinned: dict[int, int]  # option index -> exact DTZ of that move


def candidates(dtz: int, rounded: bool) -> tuple[int, ...]:
    """Values a read DTZ can stand for."""
    if not rounded:
        return (dtz,)
    if dtz % 2 == 1:
        return (dtz, dtz + 1)
    return (dtz - 1, dtz, dtz + 1)


def move_option(child_dtz: int, child_rounded: bool, zeroing: bool,
                cursed_exit: bool) -> MoveOption:
    """A zeroing move is worth 1. A quiet move is worth one more than its
    child, forced odd when it is a cursed exit."""
    if zeroing:
        return MoveOption((), (1,))
    child = candidates(child_dtz, child_rounded)
    value = tuple(((c + 1) | 1) if cursed_exit else c + 1 for c in child)
    return MoveOption(child, value)


def resolve(root_dtz: int, root_rounded: bool, options: Sequence[MoveOption],
            winning: bool) -> Resolution:
    """`options` are the moves that keep the root's class."""
    at_least_as_good = operator.ge if winning else operator.le
    feasible = [
        x for x in candidates(root_dtz, root_rounded)
        if all(any(at_least_as_good(v, x) for v in o.value) for o in options)
        and any(x in o.value for o in options)
    ]
    if len(feasible) != 1:
        return Resolution(None, {})
    x = feasible[0]
    pinned: dict[int, int] = {}
    for k, option in enumerate(options):
        if len(set(option.value)) < 2:
            continue
        others_attain = any(x in other.value
                            for j, other in enumerate(options) if j != k)
        kept = {v for v in option.value
                if at_least_as_good(v, x) and (v == x or others_attain)}
        if len(kept) == 1:
            pinned[k] = kept.pop()
    return Resolution(x, pinned)
