import Foundation

/// Plausible sample data so the app is usable before the Worker is deployed, and for SwiftUI previews.
public struct DemoDesk: DeskService {
    let now: Date

    public init(now: Date = Date()) {
        self.now = now
    }

    private func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }

    public func state() async throws -> DeskState {
        let positions = demoPositions.filter(\.isOpen)
        return DeskState(
            mode: .paper, halted: false, startPusd: 1000, totalPusd: 1043.27, updatedAt: ago(3), bchPusd: 341.12,
            holdings: [
                Holding(asset: "pusd", symbol: "PUSD", amount: 71_250, valuePusd: 712.50),
                Holding(asset: "bch", symbol: "BCH", amount: 52_000_000, valuePusd: 177.38),
                Holding(asset: "furu", symbol: "FURU", amount: 1_250_000, valuePusd: 98.41),
                Holding(asset: "dogecash", symbol: "DCASH", amount: 4_000, valuePusd: 54.98),
            ],
            positions: positions,
            agents: [
                AgentStatus(agent: "nova", status: "Approved 1 of 2 proposals", updatedAt: ago(4)),
                AgentStatus(agent: "orin", status: "Scanned 214 tokens, 3 signals", updatedAt: ago(6)),
                AgentStatus(agent: "vela", status: "Writing thesis on FURU", updatedAt: ago(5)),
                AgentStatus(agent: "kade", status: "Vetoed DCASH: pool too thin", updatedAt: ago(5)),
                AgentStatus(agent: "rune", status: "Filled BUY FURU (paper)", updatedAt: ago(3)),
                AgentStatus(agent: "zara", status: "Journal due 21:00 UTC", updatedAt: ago(40)),
            ],
            stats: .init(closed: 9, wins: 6, winRate: 6.0 / 9.0, realizedPusd: 31.80),
            grokBot: GrokBotStatus(tokenCreatedAt: ago(60 * 24 * 2), lastSeen: ago(4))
        )
    }

    public func events(after: Int, limit: Int) async throws -> [DeskEvent] {
        let rows: [(String, String, String)] = [
            ("rune", "fill", "Paper BUY 1,250,000 FURU for 95.00 PUSD at 0.000076, impact 0.8%"),
            ("nova", "decision", "Approved FURU medium-horizon long, 9.5% of book, target +18%, stop -8%"),
            ("kade", "risk-pass", "FURU passes: pool 41 days old, TVL 38 BCH, no minting baton, top holder 7%"),
            ("kade", "risk-fail", "DCASH rejected: trade would be 4.1% of pool liquidity (limit 2%)"),
            ("vela", "proposal", "FURU: volume up 3.2x on 24h, BCMR verified, active dev. Buy 95 PUSD, medium horizon"),
            ("vela", "proposal", "DCASH: breakout above 7-day range. Buy 60 PUSD, short horizon"),
            ("orin", "signal", "FURU volume spike 3.2x vs 7-day average"),
            ("orin", "signal", "DCASH price +14% in 4h"),
            ("orin", "scan", "Scanned 214 Cauldron tokens, 3 signals"),
            ("zara", "note", "Win rate 67% over 9 closed trades; short-horizon stops hit twice this week"),
            ("desk", "start", "Cycle 412 started"),
        ]
        let lastId = 5000
        let events = rows.enumerated().compactMap { i, r -> DeskEvent? in
            let id = lastId - i
            guard id > after else { return nil }
            return DeskEvent(id: id, ts: ago(Double(i) * 1.5 + 3), cycle: 412, agent: r.0, kind: r.1, message: r.2)
        }
        return Array(events.prefix(limit))
    }

    public func snapshots(days: Int) async throws -> [Snapshot] {
        let points = 120
        let span = Double(days) * 86_400
        return (0...points).map { i in
            let t = Double(i) / Double(points)
            let wave = sin(t * 9) * 6 + sin(t * 31) * 2.5
            let value = 1000 + t * 43.27 + wave * (1 - abs(t - 0.5))
            return Snapshot(ts: now.addingTimeInterval(-span * (1 - t)), totalPusd: i == points ? 1043.27 : value, bchPusd: 341 + wave)
        }
    }

    public func trades() async throws -> [Trade] {
        [
            Trade(id: 31, ts: ago(3), mode: .paper, side: "buy", tokenId: "furu", symbol: "FURU", amount: 1_250_000, pusd: 95.00,
                  pricePusd: 0.000076, impactPct: 0.8, estimated: false, positionId: 14, reason: "Volume spike with verified metadata"),
            Trade(id: 30, ts: ago(190), mode: .paper, side: "sell", tokenId: "zbch", symbol: "ZBCH", amount: 800, pusd: 61.20,
                  pricePusd: 0.0765, impactPct: 1.1, estimated: true, positionId: 12, reason: "Target +18% hit"),
            Trade(id: 29, ts: ago(620), mode: .paper, side: "sell", tokenId: "moon", symbol: "MOON", amount: 9_000, pusd: 27.60,
                  pricePusd: 0.00307, impactPct: 0.4, estimated: false, positionId: 11, reason: "Stop -8% hit"),
            Trade(id: 28, ts: ago(1400), mode: .paper, side: "buy", tokenId: "dogecash", symbol: "DCASH", amount: 4_000, pusd: 50.00,
                  pricePusd: 0.0125, impactPct: 1.6, estimated: false, positionId: 13, reason: "Range breakout"),
        ]
    }

    public func positions() async throws -> [Position] { demoPositions }

    var demoPositions: [Position] {
        [
            Position(id: 14, tokenId: "furu", symbol: "FURU", horizon: "medium", amount: 1_250_000, costPusd: 95.00,
                     entryPricePusd: 0.000076, targetPct: 18, stopPct: 8, thesis: "Volume up 3.2x, BCMR verified, active developer.",
                     openedAt: ago(3), valuePusd: 98.41, pnlPct: 3.59),
            Position(id: 13, tokenId: "dogecash", symbol: "DCASH", horizon: "short", amount: 4_000, costPusd: 50.00,
                     entryPricePusd: 0.0125, targetPct: 25, stopPct: 10, thesis: "Breakout above the 7-day range.",
                     openedAt: ago(1400), valuePusd: 54.98, pnlPct: 9.96),
            Position(id: 12, tokenId: "zbch", symbol: "ZBCH", horizon: "medium", amount: 800, costPusd: 51.90,
                     entryPricePusd: 0.0649, targetPct: 18, stopPct: 8, thesis: nil, openedAt: ago(4000),
                     closedAt: ago(190), exitPusd: 61.20, closeReason: "target", status: "closed"),
            Position(id: 11, tokenId: "moon", symbol: "MOON", horizon: "short", amount: 9_000, costPusd: 30.00,
                     entryPricePusd: 0.00333, targetPct: 25, stopPct: 8, thesis: nil, openedAt: ago(2000),
                     closedAt: ago(620), exitPusd: 27.60, closeReason: "stop", status: "closed"),
        ]
    }

    public func journal() async throws -> [JournalEntry] {
        [
            JournalEntry(id: 3, ts: ago(60 * 15), text: "Up 1.9% on the day, mostly from the ZBCH target. MOON stopped out after a fake breakout; Orin's breakout signal fired on a single large buy. PUSD remains 68% of the book.",
                         lessons: ["Require two independent buyers before treating a breakout as real.", "Thin pools: keep size under 2% of pool liquidity."]),
            JournalEntry(id: 2, ts: ago(60 * 39), text: "Quiet day. Kade vetoed three proposals on liquidity. No fills.", lessons: []),
        ]
    }

    public func lessons() async throws -> [Lesson] {
        [
            Lesson(id: 7, ts: ago(60 * 15), lesson: "Require two independent buyers before treating a breakout as real.", status: "active"),
            Lesson(id: 6, ts: ago(60 * 15), lesson: "Thin pools: keep size under 2% of pool liquidity.", status: "active"),
            Lesson(id: 5, ts: ago(60 * 63), lesson: "Sell everything at midnight UTC.", status: "rejected"),
        ]
    }

    public func team() async throws -> TeamRoster { Team.fallback }

    public func knowledge() async throws -> [KnowledgeEntry] {
        [
            KnowledgeEntry(key: "strategy", title: "Strategy", kind: "strategy", format: "markdown", body: """
            # Strategy

            Goal: **maximise holdings valued in PUSD**.

            - Long (60%): hold PUSD; BCH only when Nova's macro view is bullish.
            - Medium (25%): established CashTokens with real liquidity, trend and mean reversion on daily candles.
            - Short (15%): new tokens and volume spikes. Small fixed bets, strict rug checks, fast stops.
            """, version: 3, updatedBy: "owner", updatedAt: ago(60 * 20)),
            KnowledgeEntry(key: "risk-limits", title: "Risk limits", kind: "risk", format: "json", body: """
            {"maxPositionPct":{"short":3,"medium":8,"long":20},"minTradePusd":5,"maxPriceImpactPct":2,"maxPoolSharePct":2,"minTvlBch":{"short":5,"medium":20},"maxOpenShort":4,"dailyLossHaltPct":5}
            """, version: 2, updatedBy: "kade", updatedAt: ago(60 * 30)),
            KnowledgeEntry(key: "market", title: "Market notes", kind: "market", format: "markdown", body: """
            # Cauldron pitfalls

            - Every pool is token/BCH, so every trade is token → BCH → PUSD.
            - Pools are thin: keep each trade under 2% of pool liquidity.
            - A token whose minting baton still exists can be inflated at will.
            """, version: 5, updatedBy: "zara", updatedAt: ago(60 * 15)),
            KnowledgeEntry(key: "role:kade", title: "Kade: risk officer", kind: "role", format: "markdown", body: """
            # Kade

            You are the risk officer. You can **veto** any trade. Check pool age, TVL, holder concentration and slippage before anything is bought.
            """, version: 1, updatedBy: "seed", updatedAt: ago(60 * 40)),
        ]
    }

    public func knowledgeHistory(key: String) async throws -> [KnowledgeVersion] {
        let current = try await knowledge().first { $0.key == key }
        guard let current else { return [] }
        var versions: [KnowledgeVersion] = []
        for v in stride(from: current.version, through: 1, by: -1) {
            let body: String = v == current.version ? current.body : "(earlier version \(v))"
            let who: String = v == 1 ? "seed" : current.updatedBy
            let minutes = Double(current.version - v + 1) * 10
            versions.append(KnowledgeVersion(version: v, body: body, updatedBy: who, updatedAt: ago(minutes)))
        }
        return versions
    }

    public func scorecard() async throws -> Scorecard? {
        Scorecard(ts: ago(20), windowDays: 30,
                  overall: .init(trades: 9, winRate: 0.67, avgPnlPct: 3.4, pnlPusd: 31.8),
                  byHorizon: ["short": .init(trades: 5, winRate: 0.4, avgPnlPct: -1.2, pnlPusd: -4.1),
                              "medium": .init(trades: 4, winRate: 1, avgPnlPct: 9.1, pnlPusd: 35.9)],
                  bySignal: ["volume-spike": .init(trades: 4, winRate: 0.75, avgPnlPct: 6.0, pnlPusd: 22.0),
                             "breakout": .init(trades: 5, winRate: 0.6, avgPnlPct: 1.3, pnlPusd: 9.8)],
                  byHoldingTime: ["1-24h": .init(trades: 4, winRate: 0.5, avgPnlPct: 0.8, pnlPusd: 3.2),
                                  "1-7d": .init(trades: 5, winRate: 0.8, avgPnlPct: 5.4, pnlPusd: 28.6)])
    }

    public func proposals(limit: Int) async throws -> [Proposal] {
        [
            Proposal(id: "p-412-1", ts: ago(5), cycle: 412, agent: "vela", action: "buy", tokenId: "furu", symbol: "FURU", horizon: "medium",
                     sizePct: 9.5, targetPct: 18, stopPct: 8, signal: "volume-spike", thesis: "Volume up 3.2x on 24h with verified metadata.",
                     bullCase: "Active developer, rising holder count, deep enough pool.", bearCase: "Spike could be one whale; fades within days.",
                     status: "filled", allowedPusd: 95, riskNotes: "Pool 41 days, TVL 38 BCH, no minting baton.", decisionNote: "Approved at 9.5%.", positionId: 14),
            Proposal(id: "p-412-2", ts: ago(5), cycle: 412, agent: "vela", action: "buy", tokenId: "dogecash", symbol: "DCASH", horizon: "short",
                     sizePct: 6, targetPct: 25, stopPct: 10, signal: "breakout", thesis: "Breakout above the 7-day range.",
                     bullCase: "Momentum and social buzz.", bearCase: "Pool is thin; exit would move price.",
                     status: "risk_failed", allowedPusd: nil, riskNotes: "Trade would be 4.1% of pool liquidity (limit 2%).", decisionNote: nil, positionId: nil),
        ]
    }

    public func agentCalls(agent: String?, limit: Int) async throws -> [AgentCall] {
        let all = [
            AgentCall(id: 88, ts: ago(5), cycle: 412, agent: "vela", model: "grok-4", search: true,
                      input: "Signals: FURU volume 3.2x, DCASH +14% in 4h. Write proposals.", output: "{\"proposals\":[{\"symbol\":\"FURU\"}]}", ms: 8400),
            AgentCall(id: 87, ts: ago(6), cycle: 412, agent: "orin", model: "grok-4", search: false,
                      input: "214 tokens scanned. Summarise notable moves.", output: "FURU volume spike; DCASH breakout; nothing else notable.", ms: 3100),
            AgentCall(id: 86, ts: ago(5), cycle: 412, agent: "kade", model: "grok-4", search: false,
                      input: "Review FURU and DCASH proposals against risk limits.", output: "FURU passes. DCASH fails pool share.", ms: 2900),
        ]
        return Array(all.filter { agent == nil || $0.agent == agent }.prefix(limit))
    }

    public func agentCall(id: Int) async throws -> AgentCall {
        guard var call = try await agentCalls(agent: nil, limit: 100).first(where: { $0.id == id }) else {
            throw DeskError.http(status: 404, message: "not found")
        }
        call.systemPrompt = "You are \(Team.displayName(call.agent)) on the Cauldron trading desk."
        return call
    }
    public func tokens() async throws -> [TokenSeen] {
        [
            TokenSeen(tokenId: "furu", symbol: "FURU", name: "Furu", source: "cauldron", firstSeen: ago(60 * 24 * 41),
                      lastTvlBch: 38.2, researchStatus: "traded", lastResearchAt: ago(5)),
            TokenSeen(tokenId: "dogecash", symbol: "DCASH", name: "DogeCash", source: "cauldron", firstSeen: ago(60 * 24 * 9),
                      lastTvlBch: 4.1, researchStatus: "avoid", lastResearchAt: ago(5)),
            TokenSeen(tokenId: "lumen", symbol: "LUMEN", name: "Lumen", source: "cauldron", firstSeen: ago(180),
                      lastTvlBch: 12.6, researchStatus: "watch", lastResearchAt: ago(35)),
            TokenSeen(tokenId: "pebble", symbol: "PBL", name: "Pebble", source: "launchpad", firstSeen: ago(50), researchStatus: "new"),
        ]
    }

    public func research(token: String?) async throws -> [ResearchNote] {
        let all = [
            ResearchNote(id: 23, ts: ago(5), cycle: 412, agent: "vela", tokenId: "furu", symbol: "FURU", verdict: "opportunity",
                         opportunity: "Volume is rising with holder count; a medium-horizon long can ride the next listing wave.",
                         note: "BCMR metadata verified. Developer ships weekly. Pool is 41 days old with 38 BCH TVL, deep enough for 100 PUSD.",
                         sources: [URL(string: "https://x.com/furu_bch")!]),
            ResearchNote(id: 22, ts: ago(5), cycle: 412, agent: "vela", tokenId: "dogecash", symbol: "DCASH", verdict: "avoid",
                         opportunity: "Only a short squeeze; the pool is too thin to exit.",
                         note: "Price +14% in 4h on a 4 BCH pool. Two wallets hold 60% of supply."),
            ResearchNote(id: 21, ts: ago(35), cycle: 410, agent: "vela", tokenId: "lumen", symbol: "LUMEN", verdict: "watch",
                         opportunity: "Could work once the pool passes 20 BCH.",
                         note: "Three hours old. Team is public and the token has no minting baton, but liquidity is still building."),
        ]
        return all.filter { token == nil || $0.tokenId == token }
    }

    public func sentiment(subject: String?) async throws -> [SentimentReading] {
        let all = [
            SentimentReading(id: 9, ts: ago(6), cycle: 412, subject: "bch", score: 0.32, mentions: 340,
                             summary: "Upbeat on the coming upgrade; some worry about exchange outflows."),
            SentimentReading(id: 8, ts: ago(6), cycle: 412, subject: "cauldron", score: 0.55, mentions: 85,
                             summary: "Users praise the new router and lower fees."),
            SentimentReading(id: 7, ts: ago(6), cycle: 412, subject: "token", tokenId: "furu", symbol: "FURU", score: 0.6, mentions: 41,
                             summary: "Holders excited about the roadmap; a few influencers picked it up today."),
            SentimentReading(id: 6, ts: ago(6), cycle: 412, subject: "token", tokenId: "dogecash", symbol: "DCASH", score: -0.4, mentions: 22,
                             summary: "Mostly pump calls and complaints about slippage."),
        ]
        return all.filter { subject == nil || $0.subject == subject }
    }

    public func launchpad() async throws -> [LaunchpadSale] {
        [LaunchpadSale(id: "ido-7", offeredTokenId: "pebble", status: "upcoming",
                       data: #"{"name":"Pebble","price_bch":0.0001,"cap_bch":50}"#, firstSeen: ago(50), updatedAt: ago(10))]
    }

    public func files() async throws -> [BotFile] {
        demoFiles.map { var f = $0; f.body = nil; return f }
    }

    public func file(path: String) async throws -> BotFile {
        guard let f = demoFiles.first(where: { $0.path == path }) else { throw DeskError.http(status: 404, message: "no such file") }
        return f
    }

    private var demoFiles: [BotFile] {
        let watchlist = "# Watchlist\n\n- **LUMEN**: revisit when the pool passes 20 BCH.\n- **PBL**: launchpad sale opens soon; check the team first."
        let handover = "# Handover\n\nCycle 412: bought FURU. DCASH rejected on pool share. Next: re-score short horizon."
        return [
            BotFile(path: "notes/watchlist.md", version: 4, updatedBy: "vela", updatedAt: ago(35), body: watchlist),
            BotFile(path: "notes/handover.md", version: 12, updatedBy: "nova", updatedAt: ago(4), body: handover),
        ].map { var f = $0; f.bytes = f.body?.utf8.count; return f }
    }

    public func liquidity() async throws -> [LiquidityPosition] {
        [
            LiquidityPosition(id: 3, tokenId: "furu", symbol: "FURU", status: "open", openedAt: ago(60 * 20), depositPusd: 120,
                              feesPusd: 1.84, valuePusd: 121.10, ilPct: -0.6, stopPct: 8, signal: "fee-yield",
                              thesis: "Busy pool with steady two-way volume; fees should outpace impermanent loss."),
            LiquidityPosition(id: 2, tokenId: "zbch", symbol: "ZBCH", status: "closed", openedAt: ago(60 * 24 * 4), closedAt: ago(60 * 24),
                              depositPusd: 80, feesPusd: 2.10, valuePusd: 76.30, ilPct: -6.9, stopPct: 8, signal: "fee-yield",
                              thesis: "High volume after the listing.", exitPusd: 76.30, closeReason: "Price trended one way; impermanent loss beat the fees"),
        ]
    }

    public func reviews() async throws -> [TradeReview] {
        [
            TradeReview(positionId: 12, ts: ago(170), symbol: "ZBCH", process: "clean", outcomePusd: 9.30, outcomeR: 2.2,
                        finding: "Followed the plan: took profit at target."),
            TradeReview(positionId: 11, ts: ago(600), symbol: "MOON", process: "minor", breakStage: "exit", outcomePusd: -2.40, outcomeR: -1.3,
                        stopOvershootPct: 3.1, finding: "Stop filled 3.1% past the level on a thin pool. Size smaller on pools under 10 BCH."),
        ]
    }
}
