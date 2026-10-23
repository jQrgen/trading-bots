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
