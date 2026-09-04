# Third-Party Notices

This project bundles or depends on the third-party components listed
below. Each entry states the component, version, SPDX license
identifier, and source. This document is provided for attribution and
license-compliance purposes only and does not constitute legal advice;
consult qualified counsel before distributing, selling, or publicly
deploying this software.

Every file in this repository not listed in the tables below — including
`app.py`, `config.py`, `tablebase_router.py`, `static/js/*.js`,
`static/css/*.css`, `templates/*.html`, `remote/`, `Dockerfile`,
`render.yaml`, `.dockerignore`, `requirements.txt`, and `openapi.yaml`
— is original and licensed under the terms in [`LICENSE`](LICENSE).

## Summary

| Component | Version | License (SPDX) | Category |
|---|---|---|---|
| [Chessground](https://github.com/lichess-org/chessground) | 10.1.1 | `GPL-3.0-or-later` | Frontend |
| [chess.js](https://github.com/jhlywa/chess.js) | 1.4.0 | `BSD-2-Clause` | Frontend |
| [Inter](https://rsms.me/inter/) | — | `OFL-1.1` | Font |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | — | `OFL-1.1` | Font |
| cburnett piece set | — | `GPL-2.0-or-later` | Asset |
| [chess](https://github.com/noobpwnftw/python-chess) (`add-chesstb-tablebases` fork) | latest on branch | `GPL-3.0-or-later` | Python |
| [Flask](https://github.com/pallets/flask) | `>=3.0,<4.0` | `BSD-3-Clause` | Python |
| [lz4](https://github.com/python-lz4/python-lz4) | `>=4.0,<5.0` | `BSD-3-Clause` | Python |
| [waitress](https://github.com/Pylons/waitress) | `>=3.0,<4.0` | `ZPL-2.1` | Python |
| [requests](https://github.com/psf/requests) | `>=2.31,<3.0` | `Apache-2.0` | Python |
| [Flask-Limiter](https://github.com/alisaifee/flask-limiter) | `>=4.0,<5.0` | `MIT` | Python |

## Notices

The following components carry conditions beyond a standard permissive
license. Running the app privately, for yourself only, is unaffected by
any of these — they apply once the app (or a copy of it) reaches
another user, whether by distribution or network access.

- **`chess` / `chess.chesstb`** (`GPL-3.0-or-later`) — `app.py` imports
  this package directly. Under the FSF's interpretation of the GPL,
  distributing a program that directly imports a GPL-licensed library
  generally makes the combined work a derivative that must itself be
  distributed under GPL-3.0 terms.
- **Chessground** (`GPL-3.0-or-later`) — bundled in `static/vendor/`
  and served to every client. Per the [Chessground
  license](https://github.com/lichess-org/chessground/blob/v10.1.1/LICENSE),
  a website using it must make the combined client-served work
  available under the GPL. This condition is triggered by serving the
  app to any user other than yourself — including a locally hosted
  instance reachable by others over a network — not only by
  distributing server source code.

## Frontend libraries — `static/vendor/`

| File | Component | Version | License | Source |
|---|---|---|---|---|
| `chessground.min.js`, `chessground.base.css` | Chessground | 10.1.1 | `GPL-3.0-or-later` | [lichess-org/chessground](https://github.com/lichess-org/chessground) |
| `chess-1.4.0.esm.js` | chess.js | 1.4.0 | `BSD-2-Clause` | [jhlywa/chess.js](https://github.com/jhlywa/chess.js) |

## Fonts — `static/vendor/fonts/`

| File(s) | Typeface | License | Author |
|---|---|---|---|
| `Inter-Regular.woff2`, `Inter-Medium.woff2`, `Inter-SemiBold.woff2` | Inter | `OFL-1.1` | [Rasmus Andersson](https://rsms.me/inter/) |
| `JetBrainsMono-Regular.woff2`, `JetBrainsMono-Medium.woff2` | JetBrains Mono | `OFL-1.1` | [JetBrains](https://www.jetbrains.com/lp/mono/) |

## Chess piece set — `static/pieces/` (via lichess.org)

| Directory | License | Author | Source |
|---|---|---|---|
| `cburnett/` | `GPL-2.0-or-later` | Colin M.L. Burnett | [lila COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md) |

## Python dependencies — `requirements.txt`

| Package | License | Notes |
|---|---|---|
| `chess` (installed from `noobpwnftw/python-chess`, `add-chesstb-tablebases` branch) | `GPL-3.0-or-later` | Fork of [niklasf/python-chess](https://github.com/niklasf/python-chess). Both the base `chess` package and `chess.chesstb` are imported directly by `app.py`. |
| Flask | `BSD-3-Clause` | [pallets/flask](https://github.com/pallets/flask) |
| lz4 | `BSD-3-Clause` | [python-lz4/python-lz4](https://github.com/python-lz4/python-lz4). Optional but recommended: `chess.chesstb` picks it up itself at import time to accelerate its own block decompression, falling back to its own pure-Python decoder if not present. `app.py` doesn't import or reference it directly. |
| waitress | `ZPL-2.1` | [Pylons/waitress](https://github.com/Pylons/waitress) |
| requests | `Apache-2.0` | [psf/requests](https://github.com/psf/requests). Imported only when `TABLEBASE_PATH` is a remote `http(s)://` URL (`remote/remote_source.py`, `remote/remote_fallback.py`). |
| Flask-Limiter | `MIT` | [alisaifee/flask-limiter](https://github.com/alisaifee/flask-limiter). Provides the per-IP rate limiting on `/probe` and `/probe/stream` — see `config.py`'s `PROBE_RATE_LIMIT`. |

## License texts

| SPDX identifier | Text |
|---|---|
| `GPL-3.0-or-later` | <https://www.gnu.org/licenses/gpl-3.0.txt> |
| `GPL-2.0-or-later` | <https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt> |
| `BSD-2-Clause` | <https://spdx.org/licenses/BSD-2-Clause.html> |
| `BSD-3-Clause` | <https://spdx.org/licenses/BSD-3-Clause.html> |
| `OFL-1.1` | <https://scripts.sil.org/OFL> |
| `ZPL-2.1` | <https://opensource.org/license/zpl-2-1/> |
| `Apache-2.0` | <https://www.apache.org/licenses/LICENSE-2.0.txt> |
| `MIT` | <https://spdx.org/licenses/MIT.html> |

## Tablebase data

Not covered by this document. This project only displays results from
ChessTB tablebase files supplied by the user (see `README.md` →
"Getting the tablebase files"). No tablebase data is bundled with the
app.
