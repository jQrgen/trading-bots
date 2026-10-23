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
            stats: .init(closed: 9, wins: 6, winRate: 6.0 / 9.0, realizedPusd: 31.80)
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
}
