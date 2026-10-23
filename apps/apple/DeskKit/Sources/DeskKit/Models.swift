import Foundation

// Models mirror the Cloudflare Worker's read API (src/index.ts, migrations/0001_init.sql).
// The Worker sends snake_case keys and epoch-millisecond timestamps; DeskDecoder converts both.
// Every field the app can live without is optional so a new or missing column never breaks decoding.

public enum TradingMode: String, Decodable, Sendable {
    case paper, live, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TradingMode(rawValue: raw.lowercased()) ?? .unknown
    }
}

/// GET /api/state
public struct DeskState: Decodable, Sendable {
    public var mode: TradingMode
    public var halted: Bool
    public var startPusd: Double?
    public var totalPusd: Double?
    public var updatedAt: Date?
    public var bchPusd: Double?
    public var holdings: [Holding]
    public var positions: [Position]
    public var agents: [AgentStatus]
    public var stats: Stats
    /// When the Grok Bot app last talked to the desk, and why a call was last rejected.
    public var grokBot: GrokBotStatus?
    /// The single routine that plays every role. Absent on older desks.
    public var runner: RunnerStatus?
    /// The owner's kill switch: no on-chain transactions at all while set.
    public var frozen: Bool
    public var liveSince: Date?
    /// Owner's net deposits since going live. They count as capital, not profit, and start_pusd includes them.
    public var depositsPusd: Double

    public struct Stats: Decodable, Sendable {
        public var closed: Int
        public var wins: Int
        public var winRate: Double?
        public var realizedPusd: Double?
        /// Change in value over 24h net of deposits and withdrawals. Nil until there's a snapshot to compare with.
        public var change24hPusd: Double?
        /// False on desks that don't send change_24h_pusd yet; the app then works it out from snapshots.
        public var hasChange24h: Bool

        public init(closed: Int = 0, wins: Int = 0, winRate: Double? = nil, realizedPusd: Double? = nil,
                    change24hPusd: Double? = nil, hasChange24h: Bool = false) {
            self.closed = closed
            self.wins = wins
            self.winRate = winRate
            self.realizedPusd = realizedPusd
            self.change24hPusd = change24hPusd
            self.hasChange24h = hasChange24h || change24hPusd != nil
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            closed = (try? c.decodeIfPresent(Int.self, forKey: .closed)) ?? 0
            wins = (try? c.decodeIfPresent(Int.self, forKey: .wins)) ?? 0
            winRate = try? c.decodeIfPresent(Double.self, forKey: .winRate)
            realizedPusd = try? c.decodeIfPresent(Double.self, forKey: .realizedPusd)
            // convertFromSnakeCase spells "change_24h_pusd" as "change24HPusd".
            let key: CodingKeys = c.contains(.change24HPusd) ? .change24HPusd : .change24hPusd
            hasChange24h = c.contains(key)
            change24hPusd = try? c.decodeIfPresent(Double.self, forKey: key)
        }

        enum CodingKeys: String, CodingKey { case closed, wins, winRate, realizedPusd, change24HPusd, change24hPusd }
    }

    public init(mode: TradingMode, halted: Bool, startPusd: Double?, totalPusd: Double?, updatedAt: Date?, bchPusd: Double?,
                holdings: [Holding], positions: [Position], agents: [AgentStatus], stats: Stats, grokBot: GrokBotStatus? = nil,
                runner: RunnerStatus? = nil, frozen: Bool = false, liveSince: Date? = nil, depositsPusd: Double = 0) {
        self.mode = mode
        self.halted = halted
        self.startPusd = startPusd
        self.totalPusd = totalPusd
        self.updatedAt = updatedAt
        self.bchPusd = bchPusd
        self.holdings = holdings
        self.positions = positions
        self.agents = agents
        self.stats = stats
        self.grokBot = grokBot
        self.runner = runner
        self.frozen = frozen
        self.liveSince = liveSince
        self.depositsPusd = depositsPusd
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = (try? c.decodeIfPresent(TradingMode.self, forKey: .mode)) ?? .unknown
        halted = (try? c.decodeIfPresent(FlexBool.self, forKey: .halted))?.value ?? false
        startPusd = try? c.decodeIfPresent(Double.self, forKey: .startPusd)
        totalPusd = try? c.decodeIfPresent(Double.self, forKey: .totalPusd)
        updatedAt = try? c.decodeIfPresent(Date.self, forKey: .updatedAt)
        bchPusd = try? c.decodeIfPresent(Double.self, forKey: .bchPusd)
        holdings = (try? c.decodeIfPresent(LossyArray<Holding>.self, forKey: .holdings))?.items ?? []
        positions = (try? c.decodeIfPresent(LossyArray<Position>.self, forKey: .positions))?.items ?? []
        agents = (try? c.decodeIfPresent(LossyArray<AgentStatus>.self, forKey: .agents))?.items ?? []
        stats = (try? c.decodeIfPresent(Stats.self, forKey: .stats)) ?? Stats()
        grokBot = try? c.decodeIfPresent(GrokBotStatus.self, forKey: .grokBot)
        runner = try? c.decodeIfPresent(RunnerStatus.self, forKey: .runner)
        frozen = (try? c.decodeIfPresent(FlexBool.self, forKey: .frozen))?.value ?? false
        liveSince = try? c.decodeIfPresent(Date.self, forKey: .liveSince)
        depositsPusd = (try? c.decodeIfPresent(Double.self, forKey: .depositsPusd)) ?? 0
    }

    enum CodingKeys: String, CodingKey {
        case mode, halted, startPusd, totalPusd, updatedAt, bchPusd, holdings, positions, agents, stats, grokBot, runner, frozen, liveSince, depositsPusd
    }

    /// Profit since the paper (or live) start balance.
    public var pnlAllPusd: Double? {
        guard let totalPusd, let startPusd else { return nil }
        return totalPusd - startPusd
    }

    public var pnlAllPct: Double? {
        guard let pnlAllPusd, let startPusd, startPusd != 0 else { return nil }
        return pnlAllPusd / startPusd * 100
    }
}

public struct Holding: Decodable, Identifiable, Hashable, Sendable {
    public var asset: String
    public var symbol: String
    /// Base units (PUSD has 2 decimals, BCH is in satoshis).
    public var amount: Double
    public var valuePusd: Double?

    public var id: String { asset }

    public init(asset: String, symbol: String, amount: Double, valuePusd: Double?) {
        self.asset = asset
        self.symbol = symbol
        self.amount = amount
        self.valuePusd = valuePusd
    }
}

public struct Position: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var tokenId: String
    public var symbol: String
    public var horizon: String?
    public var amount: Double?
    public var costPusd: Double
    public var entryPricePusd: Double?
    public var targetPct: Double?
    public var stopPct: Double?
    public var thesis: String?
    /// Signal type that triggered the trade (e.g. "volume-spike").
    public var signal: String?
    public var openedAt: Date?
    public var closedAt: Date?
    public var exitPusd: Double?
    public var closeReason: String?
    public var status: String
    /// Only present on /api/state (open positions marked to market).
    public var valuePusd: Double?
    public var pnlPct: Double?

    public init(id: Int, tokenId: String, symbol: String, horizon: String?, amount: Double?, costPusd: Double,
                entryPricePusd: Double?, targetPct: Double?, stopPct: Double?, thesis: String?, openedAt: Date?,
                closedAt: Date? = nil, exitPusd: Double? = nil, closeReason: String? = nil, status: String = "open",
                valuePusd: Double? = nil, pnlPct: Double? = nil, signal: String? = nil) {
        self.signal = signal
        self.id = id
        self.tokenId = tokenId
        self.symbol = symbol
        self.horizon = horizon
        self.amount = amount
        self.costPusd = costPusd
        self.entryPricePusd = entryPricePusd
        self.targetPct = targetPct
        self.stopPct = stopPct
        self.thesis = thesis
        self.openedAt = openedAt
        self.closedAt = closedAt
        self.exitPusd = exitPusd
        self.closeReason = closeReason
        self.status = status
        self.valuePusd = valuePusd
        self.pnlPct = pnlPct
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        tokenId = (try? c.decodeIfPresent(String.self, forKey: .tokenId)) ?? ""
        symbol = (try? c.decodeIfPresent(String.self, forKey: .symbol)) ?? "?"
        horizon = try? c.decodeIfPresent(String.self, forKey: .horizon)
        amount = try? c.decodeIfPresent(Double.self, forKey: .amount)
        costPusd = (try? c.decodeIfPresent(Double.self, forKey: .costPusd)) ?? 0
        entryPricePusd = try? c.decodeIfPresent(Double.self, forKey: .entryPricePusd)
        targetPct = try? c.decodeIfPresent(Double.self, forKey: .targetPct)
        stopPct = try? c.decodeIfPresent(Double.self, forKey: .stopPct)
        thesis = try? c.decodeIfPresent(String.self, forKey: .thesis)
        signal = try? c.decodeIfPresent(String.self, forKey: .signal)
        openedAt = try? c.decodeIfPresent(Date.self, forKey: .openedAt)
        closedAt = try? c.decodeIfPresent(Date.self, forKey: .closedAt)
        exitPusd = try? c.decodeIfPresent(Double.self, forKey: .exitPusd)
        closeReason = try? c.decodeIfPresent(String.self, forKey: .closeReason)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "open"
        valuePusd = try? c.decodeIfPresent(Double.self, forKey: .valuePusd)
        pnlPct = try? c.decodeIfPresent(Double.self, forKey: .pnlPct)
    }

    enum CodingKeys: String, CodingKey {
        case id, tokenId, symbol, horizon, amount, costPusd, entryPricePusd, targetPct, stopPct, thesis, signal
        case openedAt, closedAt, exitPusd, closeReason, status, valuePusd, pnlPct
    }

    public var isOpen: Bool { status == "open" }

    /// Profit in PUSD: realised for closed positions, marked to market for open ones.
    public var pnlPusd: Double? {
        if let exitPusd { return exitPusd - costPusd }
        if let valuePusd { return valuePusd - costPusd }
        return nil
    }

    public var displayPnlPct: Double? {
        if let pnlPct { return pnlPct }
        guard let pnlPusd, costPusd != 0 else { return nil }
        return pnlPusd / costPusd * 100
    }
}

/// One row of agent_status. `status` is free text written by the bot, e.g. "scanning 214 tokens".
public struct AgentStatus: Decodable, Hashable, Sendable {
    public var agent: String
    public var status: String
    public var updatedAt: Date?

    public init(agent: String, status: String, updatedAt: Date?) {
        self.agent = agent
        self.status = status
        self.updatedAt = updatedAt
    }
}

/// Part of GET /api/state — the one routine that plays every role.
public struct RunnerStatus: Decodable, Hashable, Sendable {
    public var name: String
    public var brain: String?
    public var cycle: Int?
    public var state: String
    public var updatedAt: Date?
    public var nextRunAt: Date?
    public var nextJournalAt: Date?

    public init(name: String, brain: String? = nil, cycle: Int? = nil, state: String, updatedAt: Date? = nil,
                nextRunAt: Date? = nil, nextJournalAt: Date? = nil) {
        self.name = name
        self.brain = brain
        self.cycle = cycle
        self.state = state
        self.updatedAt = updatedAt
        self.nextRunAt = nextRunAt
        self.nextJournalAt = nextJournalAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "Cauldron Trader"
        brain = try? c.decodeIfPresent(String.self, forKey: .brain)
        cycle = try? c.decodeIfPresent(Int.self, forKey: .cycle)
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "waiting"
        updatedAt = try? c.decodeIfPresent(Date.self, forKey: .updatedAt)
        nextRunAt = try? c.decodeIfPresent(Date.self, forKey: .nextRunAt)
        nextJournalAt = try? c.decodeIfPresent(Date.self, forKey: .nextJournalAt)
    }

    enum CodingKeys: String, CodingKey {
        case name, brain, cycle, state, updatedAt, nextRunAt, nextJournalAt
    }

    /// Cycle, whether the routine is running, and the next expected times.
    public var summary: String {
        let cycleText = cycle.map { "cycle \($0)" } ?? "no cycle yet"
        let stateText = state == "running" ? "running" : state == "complete" ? "done" : "waiting"
        let next = nextRunAt.map { "next run \(Self.clock($0))" } ?? "every 15 min"
        let journal = nextJournalAt.map { "journal \(Self.clock($0))" } ?? "journal 21:00 UTC"
        return "\(name) · \(cycleText) \(stateText) · \(next) · \(journal)"
    }

    private static func clock(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "HH:mm"
        return f.string(from: date) + " UTC"
    }
}

/// GET /api/events — the activity log.
public struct DeskEvent: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var ts: Date
    public var cycle: Int?
    public var agent: String
    public var kind: String
    public var message: String
    /// Raw JSON string with extra detail, if the bot attached any.
    public var data: String?

    public init(id: Int, ts: Date, cycle: Int?, agent: String, kind: String, message: String, data: String? = nil) {
        self.id = id
        self.ts = ts
        self.cycle = cycle
        self.agent = agent
        self.kind = kind
        self.message = message
        self.data = data
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        ts = try c.decode(Date.self, forKey: .ts)
        cycle = try? c.decodeIfPresent(Int.self, forKey: .cycle)
        agent = (try? c.decodeIfPresent(String.self, forKey: .agent)) ?? "desk"
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "note"
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
        data = try? c.decodeIfPresent(String.self, forKey: .data)
    }

    enum CodingKeys: String, CodingKey { case id, ts, cycle, agent, kind, message, data }

    /// `data` pretty-printed for the detail view.
    public var prettyData: String? {
        guard let data, let raw = data.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: raw),
              let out = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        else { return data }
        return String(decoding: out, as: UTF8.self)
    }
}

/// GET /api/trades — every fill, paper or live.
public struct Trade: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var ts: Date
    public var cycle: Int?
    public var mode: TradingMode
    public var side: String
    public var tokenId: String
    public var symbol: String
    public var amount: Double?
    public var pusd: Double
    public var pricePusd: Double?
    public var impactPct: Double?
    public var estimated: Bool
    public var positionId: Int?
    public var reason: String?
    /// On-chain transaction id, for live fills.
    public var txid: String?

    public init(id: Int, ts: Date, cycle: Int? = nil, mode: TradingMode, side: String, tokenId: String, symbol: String,
                amount: Double?, pusd: Double, pricePusd: Double?, impactPct: Double?, estimated: Bool,
                positionId: Int?, reason: String?, txid: String? = nil) {
        self.id = id
        self.ts = ts
        self.cycle = cycle
        self.mode = mode
        self.side = side
        self.tokenId = tokenId
        self.symbol = symbol
        self.amount = amount
        self.pusd = pusd
        self.pricePusd = pricePusd
        self.impactPct = impactPct
        self.estimated = estimated
        self.positionId = positionId
        self.reason = reason
        self.txid = txid
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        ts = try c.decode(Date.self, forKey: .ts)
        cycle = try? c.decodeIfPresent(Int.self, forKey: .cycle)
        mode = (try? c.decodeIfPresent(TradingMode.self, forKey: .mode)) ?? .unknown
        side = (try? c.decodeIfPresent(String.self, forKey: .side))?.lowercased() ?? "?"
        tokenId = (try? c.decodeIfPresent(String.self, forKey: .tokenId)) ?? ""
        symbol = (try? c.decodeIfPresent(String.self, forKey: .symbol)) ?? "?"
        amount = try? c.decodeIfPresent(Double.self, forKey: .amount)
        pusd = (try? c.decodeIfPresent(Double.self, forKey: .pusd)) ?? 0
        pricePusd = try? c.decodeIfPresent(Double.self, forKey: .pricePusd)
        impactPct = try? c.decodeIfPresent(Double.self, forKey: .impactPct)
        estimated = (try? c.decodeIfPresent(FlexBool.self, forKey: .estimated))?.value ?? false
        positionId = try? c.decodeIfPresent(Int.self, forKey: .positionId)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        txid = try? c.decodeIfPresent(String.self, forKey: .txid)
    }

    enum CodingKeys: String, CodingKey {
        case id, ts, cycle, mode, side, tokenId, symbol, amount, pusd, pricePusd, impactPct, estimated, positionId, reason, txid
    }

    /// Buying a token or putting liquidity into a pool.
    public var isBuy: Bool { side == "buy" || side == "lp-in" }

    /// BUY, SELL, ADD LIQ, WITHDRAW or CONVERT (a BCH top-up swapped to PUSD).
    public var sideLabel: String {
        switch side {
        case "lp-in": "ADD LIQ"
        case "lp-out": "WITHDRAW"
        default: side.uppercased()
        }
    }
}

/// GET /api/snapshots?days=N — balance history, oldest first.
public struct Snapshot: Decodable, Identifiable, Hashable, Sendable {
    public var ts: Date
    public var totalPusd: Double
    public var bchPusd: Double?

    public var id: Date { ts }

    public init(ts: Date, totalPusd: Double, bchPusd: Double?) {
        self.ts = ts
        self.totalPusd = totalPusd
        self.bchPusd = bchPusd
    }
}

/// GET /api/journal — Zara's daily reports.
public struct JournalEntry: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var ts: Date
    public var text: String
    /// Lessons extracted that day. The Worker stores them as a JSON string.
    public var lessons: [String]

    public init(id: Int, ts: Date, text: String, lessons: [String]) {
        self.id = id
        self.ts = ts
        self.text = text
        self.lessons = lessons
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        ts = try c.decode(Date.self, forKey: .ts)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        if let list = try? c.decodeIfPresent([String].self, forKey: .lessons) {
            lessons = list
        } else if let raw = try? c.decodeIfPresent(String.self, forKey: .lessons) {
            lessons = JournalEntry.parseLessons(raw)
        } else {
            lessons = []
        }
    }

    enum CodingKeys: String, CodingKey { case id, ts, text, lessons }

    static func parseLessons(_ raw: String) -> [String] {
        guard let data = raw.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) else {
            return raw.isEmpty ? [] : [raw]
        }
        if let list = obj as? [Any] {
            return list.compactMap { item in
                if let s = item as? String { return s }
                if let d = item as? [String: Any] { return (d["lesson"] ?? d["text"]) as? String }
                return nil
            }
        }
        return []
    }
}

/// GET /api/lessons — rules Zara learned. Active lessons feed the agents.
public struct Lesson: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var ts: Date
    public var lesson: String
    public var status: String

    public var isActive: Bool { status == "active" }

    public init(id: Int, ts: Date, lesson: String, status: String) {
        self.id = id
        self.ts = ts
        self.lesson = lesson
        self.status = status
    }
}

// MARK: - Lenient decoding helpers

/// Decodes an array, dropping elements that fail instead of failing the whole response.
public struct LossyArray<Element: Decodable>: Decodable {
    public var items: [Element]

    public init(from decoder: Decoder) throws {
        items = try decoder.singleValueContainer().decode([Attempt].self).compactMap(\.value)
    }

    /// Always decodes (so the array cursor advances), keeping the element only if it was valid.
    private struct Attempt: Decodable {
        var value: Element?
        init(from decoder: Decoder) throws { value = try? Element(from: decoder) }
    }
}

/// SQLite has no boolean type, so flags arrive as 0/1, true/false or "1".
struct FlexBool: Decodable {
    var value: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) {
            value = b
        } else if let n = try? c.decode(Double.self) {
            value = n != 0
        } else {
            let s = try c.decode(String.self).lowercased()
            value = s == "1" || s == "true" || s == "yes"
        }
    }
}
