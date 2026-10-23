# Trading Desk for iPhone, iPad, Mac and Apple TV

A native SwiftUI app that shows what the bot team is doing. It is **read-only**: it reads the Cloudflare Worker's `/api/*` endpoints (backed by D1) and never trades, halts or changes anything.

| Screen | What it shows |
|---|---|
| Desk | Total value in PUSD, P&L since start and over 24h, win rate, balance chart (24h to 90d), holdings, open positions, agent tiles, latest activity |
| Agents | Reporting structure (from `graph/team.yaml`), each agent's live status and its own activity log |
| Activity | Every event the bots log (scan, signal, proposal, risk pass/fail, decision, fill, journal…), filterable by agent, with the raw data |
| Trades | Fills, open positions and closed positions, with thesis, target/stop and close reason |
| Journal | Zara's daily reports and the lessons (active and rejected) |

On the Mac it's a proper desktop app rather than a stretched phone layout:

- A sidebar window (several windows are fine) with ⌘1 to ⌘5 to switch sections (the **Go** menu) and ⌘R to refresh.
- Activity and Trades are sortable, searchable tables. Selecting a row opens its details in an inspector on the right.
- A **menu bar extra** shows total value at all times. Clicking it shows P&L, win rate, the latest bot activity and an Open Desk button, so you can keep an eye on the desk with the window closed.
- Preferences live in the standard Settings window (⌘,).

It refreshes every 30 seconds by default, and only fetches events newer than the last one it saw.

## Layout

```
apps/apple/
  project.yml          XcodeGen spec: iOS, macOS and tvOS app targets
  App/                 SwiftUI views, shared by all three platforms
  DeskKit/             Swift package: API models, client, store, demo data, tests
```

All logic lives in `DeskKit` so it can be tested with `swift test`. The views use `#if os(...)` only where the platforms differ: a sidebar on the Mac, tabs on iPhone/iPad and Apple TV, and focusable cards on Apple TV.

## Run it

```sh
brew install xcodegen
cd apps/apple
xcodegen            # writes TradingDesk.xcodeproj (git-ignored)
open TradingDesk.xcodeproj
```

Pick the `TradingDesk-iOS`, `TradingDesk-macOS` or `TradingDesk-tvOS` scheme and run. Signing uses the team set in `project.yml` (`DEVELOPMENT_TEAM`) with automatic provisioning.

With no desk URL set, the app shows **demo data**. To see the real bots, open Settings and enter the Worker URL, e.g. `https://cauldron-trading-desk.<account>.workers.dev`. `http://localhost:8787` works too while running `wrangler dev`.

Tests:

```sh
cd apps/apple/DeskKit && swift test
```

CI (`.github/workflows/apple.yml`) runs the tests and builds all three apps on every PR that touches `apps/apple/`.

## API

The app reads these endpoints from `src/index.ts` (snake_case JSON, epoch-millisecond timestamps, newest first unless noted):

| Endpoint | Used for |
|---|---|
| `GET /api/state` | Mode, halted flag, totals, holdings, open positions marked to market, agent statuses, win rate |
| `GET /api/events?after=<id>&limit=` | Activity log (incremental) |
| `GET /api/snapshots?days=N` | Balance chart (oldest first) |
| `GET /api/trades` | Fills |
| `GET /api/positions` | Open and closed positions |
| `GET /api/journal` | Daily reports (`lessons` is a JSON string) |
| `GET /api/lessons` | Lessons with `active` / `rejected` status |

Decoding is lenient: unknown fields are ignored, missing optional fields are fine, and a malformed row is dropped rather than failing the whole screen. If the Worker's response shapes change, update `DeskKit/Sources/DeskKit/Models.swift` and the fixtures in `DeskKitTests`.

If the team changes, update `Team.members` in `DeskKit/Sources/DeskKit/Team.swift` to match `graph/team.yaml`.

## App Store Connect and TestFlight

One bundle ID, `com.jqrgen.tradingdesk` (team `YQBXSUUVJD`), is shared by all three targets, so they form one App Store record (universal purchase). App Privacy is "Data Not Collected", and export compliance is already declared (`ITSAppUsesNonExemptEncryption = NO`).

`.github/workflows/testflight.yml` archives the iOS, macOS and tvOS apps and uploads them to App Store Connect for internal TestFlight. It runs on every push to `main` that touches `apps/apple/`, and on demand from the Actions tab (Run workflow). Signing is fully automatic: Xcode uses the API key to create the distribution certificate and profiles in the cloud, so no certificates are stored in the repo. Each run's number becomes the build number.

One-time setup, as repository secrets (Settings > Secrets and variables > Actions > New repository secret):

| Secret | Value |
|---|---|
| `ASC_KEY_ID` | The key's Key ID (App Store Connect > Users and Access > Integrations > App Store Connect API) |
| `ASC_ISSUER_ID` | The Issuer ID shown above the keys list on the same page |
| `ASC_KEY_P8` | The whole contents of `AuthKey_<KEYID>.p8`, including the BEGIN/END lines |

The key needs the **Admin** role so Xcode can create the cloud-managed distribution certificate. With the GitHub CLI on the Mac that holds the key:

```sh
gh secret set ASC_KEY_ID -R jQrgen/trading-bots --body "<KEY ID>"
gh secret set ASC_ISSUER_ID -R jQrgen/trading-bots --body "<ISSUER ID>"
gh secret set ASC_KEY_P8 -R jQrgen/trading-bots < ~/path/to/AuthKey_<KEYID>.p8
```

Builds appear in TestFlight after Apple finishes processing them, usually 5 to 30 minutes. Internal testers get them once the build is added to the internal group, or automatically if the group has automatic distribution turned on.

App icons are generated by `scripts/make_icons.py` into `Resources/<platform>/Assets.xcassets`; re-run it after changing the design.
