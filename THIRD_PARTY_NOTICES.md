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

### Protomaps vector tiles (used when self-hosted tiles are enabled)

- Protomaps public basemap in PMTiles format, derived from OpenStreetMap data.
- Project: https://protomaps.com/
- Required attribution: `Protomaps © OpenStreetMap contributors`
- Source data license: Open Database License (ODbL)

## Geocoding (Address Search)

Resolving an address / station / place name to a map center point uses one of the
following providers (selectable via `VITE_GEOCODER`):

### GSI Address Search API (default)

- Provider: Geospatial Information Authority of Japan (国土地理院), https://www.gsi.go.jp/
- Terms: GSI content usage terms (Public Data License 1.0 / PDL1.0),
  https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html
- Required attribution: `住所検索: 国土地理院` (Address search: GSI Japan)

### OpenStreetMap Nominatim (fallback provider)

- Attribution: `© OpenStreetMap contributors`, https://www.openstreetmap.org/copyright
- Usage policy: https://operations.osmfoundation.org/policies/nominatim/

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
