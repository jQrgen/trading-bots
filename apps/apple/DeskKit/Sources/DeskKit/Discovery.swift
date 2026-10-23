import Foundation

// Models for what the team finds outside its own trades: new tokens, research notes, sentiment,
// launchpad sales and the notes the agents share (src/index.ts: /api/tokens, /api/research,
// /api/sentiment, /api/launchpad, /api/files).

/// GET /api/tokens — every token the scanners have seen on Cauldron or the launchpad, newest first.
public struct TokenSeen: Decodable, Identifiable, Hashable, Sendable {
    public var tokenId: String
    public var symbol: String
    public var name: String?
    /// "cauldron" or "launchpad".
    public var source: String
    public var firstSeen: Date
    public var firstPoolTs: Date?
    public var lastTvlBch: Double?
    /// new, researched, watch, avoid or traded.
    public var researchStatus: String
    public var lastResearchAt: Date?

    public var id: String { tokenId }

    public init(tokenId: String, symbol: String, name: String? = nil, source: String, firstSeen: Date, firstPoolTs: Date? = nil,
                lastTvlBch: Double? = nil, researchStatus: String = "new", lastResearchAt: Date? = nil) {
        self.tokenId = tokenId
        self.symbol = symbol
        self.name = name
        self.source = source
        self.firstSeen = firstSeen
        self.firstPoolTs = firstPoolTs
        self.lastTvlBch = lastTvlBch
        self.researchStatus = researchStatus
        self.lastResearchAt = lastResearchAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokenId = try c.decode(String.self, forKey: .tokenId)
        symbol = (try? c.decodeIfPresent(String.self, forKey: .symbol)) ?? "?"
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "cauldron"
        firstSeen = try c.decode(Date.self, forKey: .firstSeen)
        firstPoolTs = try? c.decodeIfPresent(Date.self, forKey: .firstPoolTs)
        lastTvlBch = try? c.decodeIfPresent(Double.self, forKey: .lastTvlBch)
        researchStatus = (try? c.decodeIfPresent(String.self, forKey: .researchStatus)) ?? "new"
        lastResearchAt = try? c.decodeIfPresent(Date.self, forKey: .lastResearchAt)
    }

    enum CodingKeys: String, CodingKey {
        case tokenId, symbol, name, source, firstSeen, firstPoolTs, lastTvlBch, researchStatus, lastResearchAt
    }
}

/// GET /api/research — what an agent found when researching a token, and how it could make money.
public struct ResearchNote: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var ts: Date
    public var cycle: Int?
    public var agent: String
    public var tokenId: String
    public var symbol: String
    /// opportunity, watch or avoid.
    public var verdict: String
    public var opportunity: String?
    public var note: String
    /// Links Grok used (stored as a JSON array string).
    public var sources: [URL]

    public init(id: Int, ts: Date, cycle: Int? = nil, agent: String, tokenId: String, symbol: String, verdict: String,
                opportunity: String? = nil, note: String, sources: [URL] = []) {
        self.id = id
        self.ts = ts
        self.cycle = cycle
        self.agent = agent
        self.tokenId = tokenId
        self.symbol = symbol
        self.verdict = verdict
        self.opportunity = opportunity
        self.note = note
        self.sources = sources
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        ts = try c.decode(Date.self, forKey: .ts)
        cycle = try? c.decodeIfPresent(Int.self, forKey: .cycle)
        agent = (try? c.decodeIfPresent(String.self, forKey: .agent)) ?? "desk"
        tokenId = try c.decode(String.self, forKey: .tokenId)
        symbol = (try? c.decodeIfPresent(String.self, forKey: .symbol)) ?? "?"
        verdict = (try? c.decodeIfPresent(String.self, forKey: .verdict)) ?? "watch"
        opportunity = try? c.decodeIfPresent(String.self, forKey: .opportunity)
        note = (try? c.decodeIfPresent(String.self, forKey: .note)) ?? ""
        sources = Links.decode(c, .sources)
    }

    enum CodingKeys: String, CodingKey { case id, ts, cycle, agent, tokenId, symbol, verdict, opportunity, note, sources }
}

/// GET /api/sentiment — mood on X about a token, Cauldron itself or the BCH market, as judged by Grok.
public struct SentimentReading: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var ts: Date
    public var cycle: Int?
    /// "token", "cauldron" or "bch".
    public var subject: String
    public var tokenId: String?
    public var symbol: String?
    /// -1 (very negative) to +1 (very positive).
    public var score: Double
    public var mentions: Int?
    public var summary: String
    public var sources: [URL]

    public init(id: Int, ts: Date, cycle: Int? = nil, subject: String, tokenId: String? = nil, symbol: String? = nil,
                score: Double, mentions: Int? = nil, summary: String, sources: [URL] = []) {
        self.id = id
        self.ts = ts
        self.cycle = cycle
        self.subject = subject
        self.tokenId = tokenId
        self.symbol = symbol
        self.score = score
        self.mentions = mentions
        self.summary = summary
        self.sources = sources
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        ts = try c.decode(Date.self, forKey: .ts)
        cycle = try? c.decodeIfPresent(Int.self, forKey: .cycle)
        subject = (try? c.decodeIfPresent(String.self, forKey: .subject)) ?? "token"
        tokenId = try? c.decodeIfPresent(String.self, forKey: .tokenId)
        symbol = try? c.decodeIfPresent(String.self, forKey: .symbol)
        score = max(-1, min(1, try c.decode(Double.self, forKey: .score)))
        mentions = try? c.decodeIfPresent(Int.self, forKey: .mentions)
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        sources = Links.decode(c, .sources)
    }

    enum CodingKeys: String, CodingKey { case id, ts, cycle, subject, tokenId, symbol, score, mentions, summary, sources }

    /// "BCH market", "Cauldron" or the token's symbol.
    public var title: String {
        switch subject {
        case "bch": "BCH market"
        case "cauldron": "Cauldron"
        default: symbol ?? tokenId ?? "Token"
        }
    }

    public var moodLabel: String {
        switch score {
        case 0.5...: "Very positive"
        case 0.15..<0.5: "Positive"
        case -0.15..<0.15: "Neutral"
        case -0.5 ..< -0.15: "Negative"
        default: "Very negative"
        }
    }
}

/// GET /api/launchpad — token sales (IDOs) from the Cauldron indexer, as last seen.
public struct LaunchpadSale: Decodable, Identifiable, Hashable, Sendable {
    public var id: String
    public var offeredTokenId: String?
    public var status: String?
    /// The indexer's raw record, as JSON text.
    public var data: String
    public var firstSeen: Date
    public var updatedAt: Date

    public init(id: String, offeredTokenId: String? = nil, status: String? = nil, data: String, firstSeen: Date, updatedAt: Date) {
        self.id = id
        self.offeredTokenId = offeredTokenId
        self.status = status
        self.data = data
        self.firstSeen = firstSeen
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s } else { id = String(try c.decode(Int.self, forKey: .id)) }
        offeredTokenId = try? c.decodeIfPresent(String.self, forKey: .offeredTokenId)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        data = (try? c.decodeIfPresent(String.self, forKey: .data)) ?? "{}"
        firstSeen = try c.decode(Date.self, forKey: .firstSeen)
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)) ?? firstSeen
    }

    enum CodingKeys: String, CodingKey { case id, offeredTokenId, status, data, firstSeen, updatedAt }
}

/// GET /api/files (without body) and /api/files/<path> (with body) — notes the agents keep for each other.
public struct BotFile: Decodable, Identifiable, Hashable, Sendable {
    public var path: String
    public var contentType: String
    public var version: Int
    public var updatedBy: String?
    public var updatedAt: Date
    public var bytes: Int?
    /// Only on the single-file call.
    public var body: String?

    public var id: String { path }
    public var isJSON: Bool { contentType.contains("json") || path.hasSuffix(".json") }
    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }

    public init(path: String, contentType: String = "text/markdown", version: Int = 1, updatedBy: String? = nil,
                updatedAt: Date, bytes: Int? = nil, body: String? = nil) {
        self.path = path
        self.contentType = contentType
        self.version = version
        self.updatedBy = updatedBy
        self.updatedAt = updatedAt
        self.bytes = bytes
        self.body = body
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        contentType = (try? c.decodeIfPresent(String.self, forKey: .contentType)) ?? "text/markdown"
        version = (try? c.decodeIfPresent(Int.self, forKey: .version)) ?? 1
        updatedBy = try? c.decodeIfPresent(String.self, forKey: .updatedBy)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        body = try? c.decodeIfPresent(String.self, forKey: .body)
        bytes = (try? c.decodeIfPresent(Int.self, forKey: .bytes)) ?? body.map { $0.utf8.count }
    }

    enum CodingKeys: String, CodingKey { case path, contentType, version, updatedBy, updatedAt, bytes, body }
}

/// Source links arrive as a JSON array in a text column, or occasionally as a real array.
enum Links {
    static func decode<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> [URL] {
        if let list = try? c.decodeIfPresent([String].self, forKey: key) { return urls(list) }
        guard let raw = try? c.decodeIfPresent(String.self, forKey: key) else { return [] }
        return parse(raw)
    }

    static func parse(_ raw: String) -> [URL] {
        if let data = raw.data(using: .utf8), let list = try? JSONSerialization.jsonObject(with: data) as? [Any] {
            return urls(list.compactMap { $0 as? String })
        }
        return urls(raw.components(separatedBy: .whitespacesAndNewlines))
    }

    private static func urls(_ list: [String]) -> [URL] {
        list.compactMap { s in
            guard let url = URL(string: s.trimmingCharacters(in: .whitespaces)), url.scheme == "https" || url.scheme == "http" else { return nil }
            return url
        }
    }
}

/// GET /api/liquidity — paper liquidity the desk provides to Cauldron pools, open ones first.
public struct LiquidityPosition: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var tokenId: String
    public var symbol: String
    /// "open" or "closed".
    public var status: String
    public var openedAt: Date
    public var closedAt: Date?
    /// PUSD spent, including the swaps to fund both sides.
    public var depositPusd: Double
    /// Estimated fee income so far.
    public var feesPusd: Double
    /// Latest mark: pool value plus fees.
    public var valuePusd: Double?
    /// Impermanent loss against just holding the deposit's BCH and tokens.
    public var ilPct: Double?
    public var stopPct: Double?
    public var signal: String?
    public var thesis: String?
    public var exitPusd: Double?
    public var closeReason: String?

    public init(id: Int, tokenId: String, symbol: String, status: String, openedAt: Date, closedAt: Date? = nil, depositPusd: Double,
                feesPusd: Double = 0, valuePusd: Double? = nil, ilPct: Double? = nil, stopPct: Double? = nil, signal: String? = nil,
                thesis: String? = nil, exitPusd: Double? = nil, closeReason: String? = nil) {
        self.id = id
        self.tokenId = tokenId
        self.symbol = symbol
        self.status = status
        self.openedAt = openedAt
        self.closedAt = closedAt
        self.depositPusd = depositPusd
        self.feesPusd = feesPusd
        self.valuePusd = valuePusd
        self.ilPct = ilPct
        self.stopPct = stopPct
        self.signal = signal
        self.thesis = thesis
        self.exitPusd = exitPusd
        self.closeReason = closeReason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        tokenId = (try? c.decodeIfPresent(String.self, forKey: .tokenId)) ?? ""
        symbol = (try? c.decodeIfPresent(String.self, forKey: .symbol)) ?? "?"
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "open"
        openedAt = try c.decode(Date.self, forKey: .openedAt)
        closedAt = try? c.decodeIfPresent(Date.self, forKey: .closedAt)
        depositPusd = try c.decode(Double.self, forKey: .depositPusd)
        feesPusd = (try? c.decodeIfPresent(Double.self, forKey: .feesPusd)) ?? 0
        valuePusd = try? c.decodeIfPresent(Double.self, forKey: .valuePusd)
        ilPct = try? c.decodeIfPresent(Double.self, forKey: .ilPct)
        stopPct = try? c.decodeIfPresent(Double.self, forKey: .stopPct)
        signal = try? c.decodeIfPresent(String.self, forKey: .signal)
        thesis = try? c.decodeIfPresent(String.self, forKey: .thesis)
        exitPusd = try? c.decodeIfPresent(Double.self, forKey: .exitPusd)
        closeReason = try? c.decodeIfPresent(String.self, forKey: .closeReason)
    }

    enum CodingKeys: String, CodingKey {
        case id, tokenId, symbol, status, openedAt, closedAt, depositPusd, feesPusd, valuePusd, ilPct, stopPct, signal, thesis, exitPusd, closeReason
    }

    public var isOpen: Bool { status == "open" }

    /// Profit so far: the exit for a closed position, else the latest mark.
    public var pnlPusd: Double? {
        guard let now = isOpen ? valuePusd : (exitPusd ?? valuePusd) else { return nil }
        return now - depositPusd
    }

    public var pnlPct: Double? {
        guard let pnlPusd, depositPusd != 0 else { return nil }
        return pnlPusd / depositPusd * 100
    }
}

/// GET /api/reviews — Zara's review of each closed trade, grading process and outcome separately.
public struct TradeReview: Decodable, Identifiable, Hashable, Sendable {
    public var positionId: Int
    public var ts: Date
    public var symbol: String
    /// "clean", "minor" or "major".
    public var process: String
    /// Where the process broke, if it did.
    public var breakStage: String?
    public var outcomePusd: Double?
    /// The result in multiples of the planned risk.
    public var outcomeR: Double?
    /// How much further than the stop the exit filled, for stopped trades.
    public var stopOvershootPct: Double?
    public var finding: String
    public var agent: String

    public var id: Int { positionId }

    public init(positionId: Int, ts: Date, symbol: String, process: String, breakStage: String? = nil, outcomePusd: Double? = nil,
                outcomeR: Double? = nil, stopOvershootPct: Double? = nil, finding: String, agent: String = "zara") {
        self.positionId = positionId
        self.ts = ts
        self.symbol = symbol
        self.process = process
        self.breakStage = breakStage
        self.outcomePusd = outcomePusd
        self.outcomeR = outcomeR
        self.stopOvershootPct = stopOvershootPct
        self.finding = finding
        self.agent = agent
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        positionId = try c.decode(Int.self, forKey: .positionId)
        ts = try c.decode(Date.self, forKey: .ts)
        symbol = (try? c.decodeIfPresent(String.self, forKey: .symbol)) ?? "?"
        process = (try? c.decodeIfPresent(String.self, forKey: .process)) ?? "clean"
        breakStage = try? c.decodeIfPresent(String.self, forKey: .breakStage)
        outcomePusd = try? c.decodeIfPresent(Double.self, forKey: .outcomePusd)
        outcomeR = try? c.decodeIfPresent(Double.self, forKey: .outcomeR)
        stopOvershootPct = try? c.decodeIfPresent(Double.self, forKey: .stopOvershootPct)
        finding = (try? c.decodeIfPresent(String.self, forKey: .finding)) ?? ""
        agent = (try? c.decodeIfPresent(String.self, forKey: .agent)) ?? "zara"
    }

    enum CodingKeys: String, CodingKey {
        case positionId, ts, symbol, process, breakStage, outcomePusd, outcomeR, stopOvershootPct, finding, agent
    }
}

/// Part of GET /api/state — whether the Grok Bot app is reaching the desk.
public struct GrokBotStatus: Decodable, Hashable, Sendable {
    public struct Failure: Decodable, Hashable, Sendable {
        public var ts: Date
        public var reason: String

        public init(ts: Date, reason: String) {
            self.ts = ts
            self.reason = reason
        }
    }

    public var tokenCreatedAt: Date?
    public var lastSeen: Date?
    public var lastAuthFailure: Failure?

    public init(tokenCreatedAt: Date? = nil, lastSeen: Date? = nil, lastAuthFailure: Failure? = nil) {
        self.tokenCreatedAt = tokenCreatedAt
        self.lastSeen = lastSeen
        self.lastAuthFailure = lastAuthFailure
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokenCreatedAt = try? c.decodeIfPresent(Date.self, forKey: .tokenCreatedAt)
        lastSeen = try? c.decodeIfPresent(Date.self, forKey: .lastSeen)
        lastAuthFailure = try? c.decodeIfPresent(Failure.self, forKey: .lastAuthFailure)
    }

    enum CodingKeys: String, CodingKey { case tokenCreatedAt, lastSeen, lastAuthFailure }

    /// A rejected call that came after the last successful one.
    public var currentFailure: Failure? {
        guard let f = lastAuthFailure else { return nil }
        if let lastSeen, lastSeen > f.ts { return nil }
        return f
    }
}

/// GET /api/markets (latest per token) and /api/ticks?token= (one token's history) — what the scanners saw on Cauldron.
public struct MarketTick: Decodable, Identifiable, Hashable, Sendable {
    public var ts: Date
    /// Missing on /api/ticks, which is already for one token.
    public var tokenId: String?
    public var symbol: String?
    public var pricePusd: Double?
    public var tvlBch: Double?
    public var chg24hPct: Double?
    public var volumeSats: Double?

    public var id: String { tokenId ?? String(ts.timeIntervalSince1970) }

    public init(ts: Date, tokenId: String? = nil, symbol: String? = nil, pricePusd: Double? = nil, tvlBch: Double? = nil,
                chg24hPct: Double? = nil, volumeSats: Double? = nil) {
        self.ts = ts
        self.tokenId = tokenId
        self.symbol = symbol
        self.pricePusd = pricePusd
        self.tvlBch = tvlBch
        self.chg24hPct = chg24hPct
        self.volumeSats = volumeSats
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ts = try c.decode(Date.self, forKey: .ts)
        tokenId = try? c.decodeIfPresent(String.self, forKey: .tokenId)
        symbol = try? c.decodeIfPresent(String.self, forKey: .symbol)
        pricePusd = try? c.decodeIfPresent(Double.self, forKey: .pricePusd)
        tvlBch = try? c.decodeIfPresent(Double.self, forKey: .tvlBch)
        chg24hPct = (try? c.decodeIfPresent(Double.self, forKey: .chg24HPct)) ?? (try? c.decodeIfPresent(Double.self, forKey: .chg24hPct))
        volumeSats = try? c.decodeIfPresent(Double.self, forKey: .volumeSats)
    }

    // convertFromSnakeCase capitalises each part, so "chg_24h_pct" arrives as "chg24HPct".
    // The lowercase key covers a decoder without the key strategy.
    enum CodingKeys: String, CodingKey { case ts, tokenId, symbol, pricePusd, tvlBch, chg24HPct, chg24hPct, volumeSats }

    /// 24h volume in BCH.
    public var volumeBch: Double? { volumeSats.map { $0 / 100_000_000 } }
}

/// Pretty-prints a JSON response, or returns nil for `null`.
enum PrettyJSON {
    static func format(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]), !(obj is NSNull) else { return nil }
        guard let out = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else {
            return String(decoding: data, as: UTF8.self)
        }
        return String(decoding: out, as: UTF8.self)
    }
}
