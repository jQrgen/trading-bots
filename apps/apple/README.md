# Trading Desk for iPhone, iPad, Mac and Apple TV

A native SwiftUI app that shows what the bot team is doing. It is **read-only**: it reads the Cloudflare Worker's `/api/*` endpoints (backed by D1) and never trades, halts or changes anything.

| Screen | What it shows |
|---|---|
| Desk | Total value in PUSD, P&L since start and over 24h, win rate, balance chart (24h to 90d), holdings, open positions, agent tiles, latest activity |
| Agents | Reporting structure (from `graph/team.yaml`), each agent's live status and its own activity log |
| Activity | Every event the bots log (scan, signal, proposal, risk pass/fail, decision, fill, journal…), filterable by agent, with the raw data |
| Trades | Fills, open positions and closed positions, with thesis, target/stop and close reason |
| Journal | Zara's daily reports and the lessons (active and rejected) |

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

## App Store Connect

One bundle ID, `com.jqrgen.tradingdesk`, is shared by all three targets, so they form one App Store record (universal purchase).

1. Register the App ID `com.jqrgen.tradingdesk` in the developer portal (no extra capabilities).
2. In App Store Connect, create a new app with iOS, macOS and tvOS, using that bundle ID.
3. Archive each scheme in Xcode and upload. Use TestFlight internal testing for private use; it needs no App Review.
4. App Privacy: "Data Not Collected". Export compliance is already declared (`ITSAppUsesNonExemptEncryption = NO`).
