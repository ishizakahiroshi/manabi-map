# Third-Party Notices

Manabi Map uses third-party open source software. This file summarizes the main
runtime and build-time dependencies used by the web application.

The authoritative dependency graph is `web/pnpm-lock.yaml`. Regenerate the
license inventory with:

```sh
cd web
pnpm licenses list
```

## Map Data and Tiles

- OpenStreetMap data and standard tiles: Open Database License (ODbL)
- Required attribution: `© OpenStreetMap contributors`
- Copyright and license: https://www.openstreetmap.org/copyright
- Tile usage policy: https://operations.osmfoundation.org/policies/tiles/

## Runtime Dependencies

| Package | License | Project |
|---|---|---|
| React | MIT | https://react.dev/ |
| React DOM | MIT | https://react.dev/ |
| React Router DOM | MIT | https://github.com/remix-run/react-router |
| React Markdown | MIT | https://github.com/remarkjs/react-markdown |
| Supabase JavaScript Client | MIT | https://github.com/supabase/supabase-js |
| Leaflet | BSD-2-Clause | https://leafletjs.com/ |

## Build and Development Dependencies

| Package | License | Project |
|---|---|---|
| Vite | MIT | https://vite.dev/ |
| TypeScript | Apache-2.0 | https://www.typescriptlang.org/ |
| Tailwind CSS | MIT | https://tailwindcss.com/ |
| Oxlint | MIT | https://oxc.rs/docs/guide/usage/linter |
| Lightning CSS | MPL-2.0 | https://github.com/parcel-bundler/lightningcss |

## Full License Families Detected

As of the current lockfile, `pnpm licenses list` reports these license families:

- 0BSD
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC
- MIT
- MPL-2.0

No GPL, LGPL, AGPL, or ethical-source restricted dependency is currently present
in the npm dependency graph.
