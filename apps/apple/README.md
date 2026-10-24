# Trading Desk for iPhone, iPad, Mac and Apple TV

A native SwiftUI app that shows what the bot team is doing. It is **read-only**: it reads the Cloudflare Worker's `/api/*` endpoints (backed by D1) and never trades, halts or changes anything.

| Screen | What it shows |
|---|---|
| Desk | LIVE/PAPER and FROZEN badges, total value in PUSD, P&L since start (or since going live, with deposits counted as capital) and over 24h net of deposits, the wallet (address with an explorer link, PUSD and BCH balances), win rate, balance chart (24h to 90d), holdings, open positions, agent tiles, latest activity |
| Agents | Reporting structure, each agent's live status, role document, tools, its own activity log and its exact Grok prompts and replies |
| Activity | Every event the bots log (scan, signal, proposal, risk pass/fail, decision, fill, journal…), filterable by agent, with the raw data |
| Trades | Trade ideas (with bull and bear case, risk check and decision), fills, open and closed positions (with Zara's review), and liquidity positions (deposit, estimated fees, impermanent loss). Live fills link their transaction. |
| Research | Market prices for every Cauldron pool (with a price chart per token), the full JSON of Grok Bot's latest briefing, the mood on X about BCH and Cauldron, every new token on Cauldron and the launchpad with its research status, Vela's research notes (verdict, how it could make money, sources) and launchpad sales |
| Playbook | Realised P&L over time, the scorecard (by horizon, signal and holding time), Zara's trade reviews, the strategy, risk limits and market notes (with version history), the agents' shared notes, Zara's daily reports and the lessons |

On the Mac it's a proper desktop app rather than a stretched phone layout:

- A sidebar window (several windows are fine) with ⌘1 to ⌘6 to switch sections (the **Go** menu) and ⌘R to refresh.
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

The app connects to the live desk, `https://cauldron-trading-desk.nordiccrypto.workers.dev`, out of the box (`AppConfig.defaultURL`). Settings can point it at `http://localhost:8787` while running `wrangler dev`, or clear the field to see **demo data**.

Tests:

```sh
cd apps/apple/DeskKit && swift test
```

CI (`.github/workflows/apple.yml`) runs the tests and builds all three apps on every PR that touches `apps/apple/`.

## API

The app reads these endpoints from `src/index.ts` (snake_case JSON, epoch-millisecond timestamps, newest first unless noted):

| Endpoint | Used for |
|---|---|
| `GET /api/state` | Mode, halted flag, totals, holdings, open positions marked to market, agent statuses, win rate, and when Grok Bot last connected or was rejected |
| `GET /api/events?after=<id>&limit=` | Activity log (incremental) |
| `GET /api/snapshots?days=N` | Balance chart (oldest first) |
| `GET /api/trades` | Fills |
| `GET /api/positions` | Open and closed positions |
| `GET /api/journal` | Daily reports (`lessons` is a JSON string) |
| `GET /api/lessons` | Lessons with `active` / `rejected` status |
| `GET /api/team` | The team graph and each agent's status |
| `GET /api/knowledge`, `/api/knowledge/<key>/history` | Strategy, risk limits, market notes, roles, and every past version |
| `GET /api/scorecard` | The rolling track record by horizon and signal (or `null`) |
| `GET /api/proposals?limit=` | Trade ideas and what happened to each |
| `GET /api/agent-calls?agent=&limit=`, `/api/agent-calls/<id>` | Grok prompts and replies, with the system prompt on the detail call (empty while the team runs in the Grok app) |
| `GET /api/tokens` | New tokens and their research status |
| `GET /api/research?token=` | Research notes (`sources` is a JSON string) |
| `GET /api/sentiment?subject=token\|cauldron\|bch` | Mood on X, score -1 to +1 |
| `GET /api/launchpad` | Launchpad sales (`data` is a JSON string) |
| `GET /api/files`, `/api/files/<path>` | The agents' shared notes; the text only on the single-file call |
| `GET /api/wallet` | The desk's own wallet: live or not, frozen, address and balances (read-only) |
| `GET /api/liquidity` | Liquidity positions, open first |
| `GET /api/markets`, `/api/ticks?token=&days=` | Latest tick per token; one token's price series (oldest first) |
| `GET /api/briefing` | The JSON Grok Bot read at its latest briefing (or `null`) |
| `GET /api/files/<path>?history=1` | Every version of a shared note |
| `GET /api/scorecards?days=90` | Scorecard history for the P&L-over-time chart |
| `GET /api/reviews` | Zara's per-trade reviews (process clean/minor/major, outcome in PUSD and R) |

Decoding is lenient: unknown fields are ignored, missing optional fields are fine, and a malformed row is dropped rather than failing the whole screen. If the Worker's response shapes change, update `DeskKit/Sources/DeskKit/Models.swift` and the fixtures in `DeskKitTests`.

All dynamic data comes from the database through these endpoints. `Team.fallback` in `DeskKit/Sources/DeskKit/Team.swift` mirrors `seed/team.json` and is used only until `/api/team` loads.

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
