import Foundation

/// Read-only access to the trading desk. The app talks to this, so the live Worker and demo data are interchangeable.
public protocol DeskService: Sendable {
    func state() async throws -> DeskState
    /// Events with id greater than `after`, newest first.
    func events(after: Int, limit: Int) async throws -> [DeskEvent]
    /// Balance history for the last `days` days, oldest first.
    func snapshots(days: Int) async throws -> [Snapshot]
    func trades() async throws -> [Trade]
    func positions() async throws -> [Position]
    func journal() async throws -> [JournalEntry]
    func lessons() async throws -> [Lesson]
    func team() async throws -> TeamRoster
    func knowledge() async throws -> [KnowledgeEntry]
    func knowledgeHistory(key: String) async throws -> [KnowledgeVersion]
    /// nil until the first scorecard is computed.
    func scorecard() async throws -> Scorecard?
    func proposals(limit: Int) async throws -> [Proposal]
    func agentCalls(agent: String?, limit: Int) async throws -> [AgentCall]
    /// One call including its system prompt.
    func agentCall(id: Int) async throws -> AgentCall
    /// New tokens on Cauldron and the launchpad, with how far research got.
    func tokens() async throws -> [TokenSeen]
    /// Research notes, for one token or (nil) all of them.
    func research(token: String?) async throws -> [ResearchNote]
    /// Sentiment readings for "token", "cauldron" or "bch", or (nil) all of them.
    func sentiment(subject: String?) async throws -> [SentimentReading]
    func launchpad() async throws -> [LaunchpadSale]
    /// The agents' shared notes, without their text.
    func files() async throws -> [BotFile]
    /// One shared note including its text.
    func file(path: String) async throws -> BotFile
    /// Paper liquidity positions, open ones first.
    func liquidity() async throws -> [LiquidityPosition]
    /// Zara's reviews of closed trades.
    func reviews() async throws -> [TradeReview]
}

public enum DeskError: LocalizedError, Equatable {
    case invalidURL(String)
    case http(status: Int, message: String?)
    case decoding(path: String, detail: String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let s): "“\(s)” isn't a valid desk URL."
        case .http(let status, let message): "The desk answered \(status)\(message.map { ": \($0)" } ?? "")."
        case .decoding(let path, let detail): "Couldn't read \(path): \(detail)"
        }
    }
}

public enum DeskDecoder {
    /// snake_case keys, and timestamps as epoch milliseconds (what the Worker sends), epoch seconds or ISO 8601.
    public static func make() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let n = try? c.decode(Double.self) {
                // Anything below ~year 5000 in seconds is treated as seconds; the Worker sends milliseconds.
                return Date(timeIntervalSince1970: n > 100_000_000_000 ? n / 1000 : n)
            }
            let s = try c.decode(String.self)
            if let n = Double(s) { return Date(timeIntervalSince1970: n > 100_000_000_000 ? n / 1000 : n) }
            if let date = parseISO(s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unrecognised date \(s)")
        }
        return d
    }

    static func parseISO(_ s: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: s) { return d }
        // SQLite's CURRENT_TIMESTAMP format, always UTC.
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.date(from: s)
    }
}

/// Talks to the Cloudflare Worker's /api/* endpoints. Reads need no auth.
public struct DeskClient: DeskService {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// Accepts "desk.example.workers.dev", "https://desk.example.workers.dev/" and similar.
    public init(urlString: String, session: URLSession = .shared) throws {
        var s = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host != nil, url.scheme == "https" || url.scheme == "http" else {
            throw DeskError.invalidURL(urlString)
        }
        self.init(baseURL: url, session: session)
    }

    public func state() async throws -> DeskState {
        try await get("api/state")
    }

    public func events(after: Int, limit: Int) async throws -> [DeskEvent] {
        try await list("api/events", ["after": "\(after)", "limit": "\(limit)"])
    }

    public func snapshots(days: Int) async throws -> [Snapshot] {
        try await list("api/snapshots", ["days": "\(days)"])
    }

    public func trades() async throws -> [Trade] { try await list("api/trades") }
    public func positions() async throws -> [Position] { try await list("api/positions") }
    public func journal() async throws -> [JournalEntry] { try await list("api/journal") }
    public func lessons() async throws -> [Lesson] { try await list("api/lessons") }
    public func team() async throws -> TeamRoster { try await get("api/team") }
    public func knowledge() async throws -> [KnowledgeEntry] { try await list("api/knowledge") }
    public func scorecard() async throws -> Scorecard? { try await get("api/scorecard") }
    public func agentCall(id: Int) async throws -> AgentCall { try await get("api/agent-calls/\(id)") }

    public func knowledgeHistory(key: String) async throws -> [KnowledgeVersion] {
        try await list("api/knowledge/\(key)/history")
    }

    public func proposals(limit: Int) async throws -> [Proposal] {
        try await list("api/proposals", ["limit": "\(limit)"])
    }

    public func agentCalls(agent: String?, limit: Int) async throws -> [AgentCall] {
        var query = ["limit": "\(limit)"]
        if let agent { query["agent"] = agent }
        return try await list("api/agent-calls", query)
    }

    public func tokens() async throws -> [TokenSeen] { try await list("api/tokens") }
    public func launchpad() async throws -> [LaunchpadSale] { try await list("api/launchpad") }
    public func files() async throws -> [BotFile] { try await list("api/files") }
    public func liquidity() async throws -> [LiquidityPosition] { try await list("api/liquidity") }
    public func reviews() async throws -> [TradeReview] { try await list("api/reviews") }

    public func file(path: String) async throws -> BotFile {
        // The Worker decodes the rest of the URL, so slashes in the path can stay as they are.
        try await get("api/files/" + path)
    }

    public func research(token: String?) async throws -> [ResearchNote] {
        try await list("api/research", token.map { ["token": $0] } ?? [:])
    }

    public func sentiment(subject: String?) async throws -> [SentimentReading] {
        try await list("api/sentiment", subject.map { ["subject": $0] } ?? [:])
    }

    func url(_ path: String, _ query: [String: String] = [:]) -> URL {
        var url = baseURL.appending(path: path)
        if !query.isEmpty {
            url.append(queryItems: query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) })
        }
        return url
    }

    private func list<T: Decodable>(_ path: String, _ query: [String: String] = [:]) async throws -> [T] {
        let rows: LossyArray<T> = try await get(path, query)
        return rows.items
    }

    private func get<T: Decodable>(_ path: String, _ query: [String: String] = [:]) async throws -> T {
        var req = URLRequest(url: url(path, query))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw DeskError.http(status: http.statusCode, message: message)
        }
        do {
            return try DeskDecoder.make().decode(T.self, from: data)
        } catch {
            throw DeskError.decoding(path: "/" + path, detail: String(describing: error))
        }
    }
}
