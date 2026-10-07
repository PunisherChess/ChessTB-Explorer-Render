# Third-Party Notices

This project bundles or depends on the third-party components listed
below. Each entry states the component, version, SPDX license
identifier, and source. This document is provided for attribution and
license-compliance purposes only and does not constitute legal advice;
consult qualified counsel before distributing, selling, or publicly
deploying this software.

Every file in this repository not listed in the tables below - including
`app.py`, `config.py`, `dtz_anchor.py`, `tablebase_opening.py`,
`tablebase_router.py`, `static/js/admin.js`,
`static/css/*.css`, `templates/*.html`,
`frontend/src/engine/`, `frontend/src/hooks/`, `frontend/src/components/`,
`frontend/src/styles/`, `frontend/src/*.jsx`, and `remote/`, `Dockerfile`, `render.yaml`,
`.dockerignore`, `requirements.txt`, and `openapi.yaml` - is original and
licensed under the terms in [`LICENSE`](LICENSE) (`GPL-3.0-or-later`).

## Summary

| Component | Version | License (SPDX) | Category |
|---|---|---|---|
| [React](https://github.com/facebook/react) | 18.3.1 | `MIT` | Frontend |
| [React DOM](https://github.com/facebook/react) | 18.3.1 | `MIT` | Frontend |
| [Scheduler](https://github.com/facebook/react) | 0.23.2 | `MIT` | Frontend |
| [Chessground](https://github.com/lichess-org/chessground) | 10.1.1 | `GPL-3.0-or-later` | Frontend |
| [chessops](https://github.com/niklasf/chessops) | 0.15.1 | `GPL-3.0-or-later` | Frontend |
| [@badrap/result](https://github.com/badrap/result) | 0.3.1 | `MIT` | Frontend |
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

This project is licensed as a whole under `GPL-3.0-or-later` - see
[`LICENSE`](LICENSE).

The following bundled components carry their own `GPL` license terms:

- **`chess` / `chess.chesstb`** (`GPL-3.0-or-later`): imported
  directly by `app.py`.
- **Chessground** (`GPL-3.0-or-later`): vendored in
  `frontend/src/vendor/`, bundled into `static/dist/app.js`, and served
  to every client.
- **chessops** (`GPL-3.0-or-later`): vendored in
  `frontend/src/vendor/chessops/`, bundled into `static/dist/app.js`,
  and served to every client.
- **cburnett piece set** (`GPL-2.0-or-later`): bundled in
  `static/pieces/cburnett/` and served to every client.

React, React DOM, Scheduler, and `@badrap/result` (`MIT`) are also
bundled into `static/dist/app.js` - see
[React / build dependencies](#react--build-dependencies-frontend) below.

## Frontend engine libraries: `frontend/src/vendor/`

| File | Component | Version | License | Source |
|---|---|---|---|---|
| `chessground.min.js` | Chessground | 10.1.1 | `GPL-3.0-or-later` | [lichess-org/chessground](https://github.com/lichess-org/chessground) |
| `chessops/*.js` (excl. `badrap-result.js`) | chessops | 0.15.1 | `GPL-3.0-or-later` | [niklasf/chessops](https://github.com/niklasf/chessops) |
| `chessops/badrap-result.js` | @badrap/result | 0.3.1 | `MIT` | [badrap/result](https://github.com/badrap/result) |
| `chessground.base.css` | Chessground stylesheet | 10.1.1 | `GPL-3.0-or-later` | [lichess-org/chessground](https://github.com/lichess-org/chessground) |

`frontend/src/vendor/` holds the pinned ESM distribution and its
`@badrap/result` runtime dependency; `vite build` bundles them into
`static/dist/app.js` together with the frontend's own code. They are
not fetched from a CDN at request time. `chessground.base.css` is
bundled into `static/dist/app.css`.

## React / build dependencies: `frontend/`

| Component | Version | License | Source |
|---|---|---|---|
| React | 18.3.1 | `MIT` | [facebook/react](https://github.com/facebook/react) |
| React DOM | 18.3.1 | `MIT` | [facebook/react](https://github.com/facebook/react) |
| Scheduler | 0.23.2 | `MIT` | [facebook/react](https://github.com/facebook/react) (React DOM's runtime dependency) |

Installed via `npm install` from `frontend/package.json` and bundled
into `static/dist/app.js` by `vite build`; not present anywhere else in
the served application. Vite and `@vitejs/plugin-react` are build-time
only and are not distributed to clients.

## Fonts: `frontend/src/assets/fonts/`

| File(s) | Typeface | License | Author |
|---|---|---|---|
| `Inter-Regular.woff2`, `Inter-Medium.woff2`, `Inter-SemiBold.woff2` | Inter | `OFL-1.1` | [Rasmus Andersson](https://rsms.me/inter/) |
| `JetBrainsMono-Regular.woff2`, `JetBrainsMono-Medium.woff2` | JetBrains Mono | `OFL-1.1` | [JetBrains](https://www.jetbrains.com/lp/mono/) |

The build copies the fonts to `static/dist/fonts/`.

## Chess piece set: `static/pieces/` (via lichess.org)

| Directory | License | Author | Source |
|---|---|---|---|
| `cburnett/` | `GPL-2.0-or-later` | Colin M.L. Burnett | [lila COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md) |

## Python dependencies: `requirements.txt`

| Package | License | Notes |
|---|---|---|
| `chess` (installed from `noobpwnftw/python-chess`, `add-chesstb-tablebases` branch) | `GPL-3.0-or-later` | Fork of [niklasf/python-chess](https://github.com/niklasf/python-chess). Both the base `chess` package and `chess.chesstb` are imported directly by `app.py`. |
| Flask | `BSD-3-Clause` | [pallets/flask](https://github.com/pallets/flask) |
| lz4 | `BSD-3-Clause` | [python-lz4/python-lz4](https://github.com/python-lz4/python-lz4). Optional but recommended: `chess.chesstb` picks it up itself at import time to accelerate its own block decompression, falling back to its own pure-Python decoder if not present. `app.py` doesn't import or reference it directly. |
| waitress | `ZPL-2.1` | [Pylons/waitress](https://github.com/Pylons/waitress) |
| requests | `Apache-2.0` | [psf/requests](https://github.com/psf/requests). Imported only when `TABLEBASE_PATH` is a remote `http(s)://` URL (`remote/remote_source.py`, `remote/remote_fallback.py`). |
| Flask-Limiter | `MIT` | [alisaifee/flask-limiter](https://github.com/alisaifee/flask-limiter). Provides the per-IP rate limiting on `/probe` and `/probe/stream` - see `config.py`'s `PROBE_RATE_LIMIT`. |

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
