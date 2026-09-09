# Third-party code and assets

Everything under `vendor/` was vendored on purpose: the game is meant to run on a network with no
internet, so nothing may be fetched from a CDN at load time. None of it is our work, and none of it
is covered by this project's GPL-3.0 licence — each item keeps the licence it arrived with, listed
below. All of these are compatible with distributing the project under GPL-3.0.

| Path | What | Upstream | Licence |
|---|---|---|---|
| `three.module.js` | three.js r170, the whole build | [three.js](https://threejs.org/) · Copyright 2010-2024 Three.js Authors | MIT (`SPDX-License-Identifier: MIT`, stated in the file header) |
| `three-addons/utils/BufferGeometryUtils.js` | the `mergeGeometries` helper the level builder needs | three.js examples, same release | MIT |
| `fonts/*.woff2`, `fonts/fonts.css` | **Caveat** and **Patrick Hand**, the two handwriting faces the whole look rests on | [Google Fonts](https://fonts.google.com/) | SIL Open Font License 1.1 |

`fonts.css` is a local copy of what the Google Fonts CSS endpoint returns, edited only so the `src:`
URLs point at the `.woff2` files sitting next to it.

Updating any of these means downloading the new file and putting it here — not adding a package
manager. See [`../AGENTS.md`](../AGENTS.md).
