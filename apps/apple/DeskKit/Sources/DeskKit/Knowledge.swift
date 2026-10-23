import Foundation

// Models for the database-backed team, knowledge, scorecard, proposals and Grok audit log
// (src/index.ts: /api/team, /api/knowledge, /api/scorecard, /api/proposals, /api/agent-calls).

/// GET /api/team — the team graph as stored in D1, with each agent's latest status.
public struct TeamRoster: Decodable, Hashable, Sendable {
    public var owner: String
    public var loop: [String]
    public var members: [TeamMember]

    public init(owner: String, loop: [String], members: [TeamMember]) {
        self.owner = owner
        self.loop = loop
        self.members = members
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        owner = (try? c.decodeIfPresent(String.self, forKey: .owner)) ?? "human"
        loop = (try? c.decodeIfPresent([String].self, forKey: .loop)) ?? []
        let agents = (try? c.decodeIfPresent(LossyArray<TeamMember>.self, forKey: .agents))?.items ?? []
        members = agents.enumerated().map { i, m in
            var m = m
            m.number = i + 1
            return m
        }
    }

    enum CodingKeys: String, CodingKey { case owner, loop, agents }

    public func member(_ id: String) -> TeamMember? {
        members.first { $0.id == id.lowercased() }
    }

    public func displayName(_ id: String) -> String {
        if id == owner { return "You" }
        return member(id)?.name ?? id.capitalized
    }

    /// Direct reports of `id` (primary reporting line only, so an agent with two managers appears once).
    public func reports(of id: String) -> [TeamMember] {
        members.filter { $0.reportsTo.first == id }
    }
}

/// GET /api/knowledge — strategy, market notes, shared rules, roles, team graph and risk limits.
public struct KnowledgeEntry: Decodable, Identifiable, Hashable, Sendable {
    public var key: String
    public var title: String
    public var kind: String
    public var format: String
    public var body: String
    public var version: Int
    public var updatedBy: String
    public var updatedAt: Date?

    public var id: String { key }
    public var isJSON: Bool { format == "json" }

    /// For role documents ("role:nova"), the agent id.
    public var roleAgent: String? {
        key.hasPrefix("role:") ? String(key.dropFirst(5)) : nil
    }

    public init(key: String, title: String, kind: String, format: String, body: String, version: Int, updatedBy: String, updatedAt: Date?) {
        self.key = key
        self.title = title
        self.kind = kind
        self.format = format
        self.body = body
        self.version = version
        self.updatedBy = updatedBy
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? key
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "other"
        format = (try? c.decodeIfPresent(String.self, forKey: .format)) ?? "markdown"
        body = (try? c.decodeIfPresent(String.self, forKey: .body)) ?? ""
        version = (try? c.decodeIfPresent(Int.self, forKey: .version)) ?? 1
        updatedBy = (try? c.decodeIfPresent(String.self, forKey: .updatedBy)) ?? "?"
        updatedAt = try? c.decodeIfPresent(Date.self, forKey: .updatedAt)
    }

    enum CodingKeys: String, CodingKey { case key, title, kind, format, body, version, updatedBy, updatedAt }
}

/// GET /api/knowledge/<key>/history
public struct KnowledgeVersion: Decodable, Identifiable, Hashable, Sendable {
    public var version: Int
    public var body: String
    public var updatedBy: String
    public var updatedAt: Date?

    public var id: Int { version }

    public init(version: Int, body: String, updatedBy: String, updatedAt: Date?) {
        self.version = version
        self.body = body
        self.updatedBy = updatedBy
        self.updatedAt = updatedAt
    }
}

/// GET /api/scorecard — the rolling track record the team uses to resize its bets.
public struct Scorecard: Decodable, Hashable, Sendable {
    public struct Bucket: Decodable, Hashable, Sendable {
        public var trades: Int
        public var winRate: Double
        public var avgPnlPct: Double
        public var pnlPusd: Double

        public init(trades: Int, winRate: Double, avgPnlPct: Double, pnlPusd: Double) {
            self.trades = trades
            self.winRate = winRate
            self.avgPnlPct = avgPnlPct
            self.pnlPusd = pnlPusd
        }
    }

    public var ts: Date?
    public var windowDays: Int?
    public var overall: Bucket
    public var byHorizon: [String: Bucket]
    public var bySignal: [String: Bucket]

    public init(ts: Date?, windowDays: Int?, overall: Bucket, byHorizon: [String: Bucket], bySignal: [String: Bucket]) {
        self.ts = ts
        self.windowDays = windowDays
        self.overall = overall
        self.byHorizon = byHorizon
        self.bySignal = bySignal
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ts = try? c.decodeIfPresent(Date.self, forKey: .ts)
        windowDays = try? c.decodeIfPresent(Int.self, forKey: .windowDays)
        overall = try c.decode(Bucket.self, forKey: .overall)
        byHorizon = (try? c.decodeIfPresent([String: Bucket].self, forKey: .byHorizon)) ?? [:]
        bySignal = (try? c.decodeIfPresent([String: Bucket].self, forKey: .bySignal)) ?? [:]
    }

    enum CodingKeys: String, CodingKey { case ts, windowDays, overall, byHorizon, bySignal }
}

/// GET /api/proposals — every trade idea and what happened to it.
public struct Proposal: Decodable, Identifiable, Hashable, Sendable {
    public var id: String
    public var ts: Date
    public var cycle: Int?
    public var agent: String
    public var action: String
    public var tokenId: String
    public var symbol: String
    public var horizon: String?
    public var sizePct: Double?
    public var targetPct: Double?
    public var stopPct: Double?
    public var signal: String?
    public var thesis: String?
    public var bullCase: String?
    public var bearCase: String?
    /// proposed, risk_passed, risk_failed, vetoed, approved, rejected, filled or skipped.
    public var status: String
    public var allowedPusd: Double?
    public var riskNotes: String?
    public var decisionNote: String?
    public var positionId: Int?

    public init(id: String, ts: Date, cycle: Int? = nil, agent: String, action: String, tokenId: String, symbol: String,
                horizon: String?, sizePct: Double?, targetPct: Double?, stopPct: Double?, signal: String?, thesis: String?,
                bullCase: String?, bearCase: String?, status: String, allowedPusd: Double?, riskNotes: String?,
                decisionNote: String?, positionId: Int?) {
        self.id = id
        self.ts = ts
        self.cycle = cycle
        self.agent = agent
        self.action = action
        self.tokenId = tokenId
        self.symbol = symbol
        self.horizon = horizon
        self.sizePct = sizePct
        self.targetPct = targetPct
        self.stopPct = stopPct
        self.signal = signal
        self.thesis = thesis
        self.bullCase = bullCase
        self.bearCase = bearCase
        self.status = status
        self.allowedPusd = allowedPusd
        self.riskNotes = riskNotes
        self.decisionNote = decisionNote
        self.positionId = positionId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) {
            id = s
        } else {
            id = String(try c.decode(Int.self, forKey: .id))
        }
        ts = try c.decode(Date.self, forKey: .ts)
        cycle = try? c.decodeIfPresent(Int.self, forKey: .cycle)
        agent = (try? c.decodeIfPresent(String.self, forKey: .agent)) ?? "vela"
        action = (try? c.decodeIfPresent(String.self, forKey: .action)) ?? "buy"
        tokenId = (try? c.decodeIfPresent(String.self, forKey: .tokenId)) ?? ""
        symbol = (try? c.decodeIfPresent(String.self, forKey: .symbol)) ?? "?"
        horizon = try? c.decodeIfPresent(String.self, forKey: .horizon)
        sizePct = try? c.decodeIfPresent(Double.self, forKey: .sizePct)
        targetPct = try? c.decodeIfPresent(Double.self, forKey: .targetPct)
        stopPct = try? c.decodeIfPresent(Double.self, forKey: .stopPct)
        signal = try? c.decodeIfPresent(String.self, forKey: .signal)
        thesis = try? c.decodeIfPresent(String.self, forKey: .thesis)
        bullCase = try? c.decodeIfPresent(String.self, forKey: .bullCase)
        bearCase = try? c.decodeIfPresent(String.self, forKey: .bearCase)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "proposed"
        allowedPusd = try? c.decodeIfPresent(Double.self, forKey: .allowedPusd)
        riskNotes = try? c.decodeIfPresent(String.self, forKey: .riskNotes)
        decisionNote = try? c.decodeIfPresent(String.self, forKey: .decisionNote)
        positionId = try? c.decodeIfPresent(Int.self, forKey: .positionId)
    }

    enum CodingKeys: String, CodingKey {
        case id, ts, cycle, agent, action, tokenId, symbol, horizon, sizePct, targetPct, stopPct, signal, thesis
        case bullCase, bearCase, status, allowedPusd, riskNotes, decisionNote, positionId
    }

    public var statusLabel: String { status.replacingOccurrences(of: "_", with: " ") }
}

/// GET /api/agent-calls — one Grok call: the exact prompt and reply.
public struct AgentCall: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int
    public var ts: Date
    public var cycle: Int?
    public var agent: String
    public var model: String
    public var search: Bool
    public var input: String
    public var output: String?
    public var error: String?
    public var ms: Int?
    /// Only on GET /api/agent-calls/<id>.
    public var systemPrompt: String?

    public init(id: Int, ts: Date, cycle: Int? = nil, agent: String, model: String, search: Bool, input: String,
                output: String?, error: String? = nil, ms: Int?, systemPrompt: String? = nil) {
        self.id = id
        self.ts = ts
        self.cycle = cycle
        self.agent = agent
        self.model = model
        self.search = search
        self.input = input
        self.output = output
        self.error = error
        self.ms = ms
        self.systemPrompt = systemPrompt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        ts = try c.decode(Date.self, forKey: .ts)
        cycle = try? c.decodeIfPresent(Int.self, forKey: .cycle)
        agent = (try? c.decodeIfPresent(String.self, forKey: .agent)) ?? "?"
        model = (try? c.decodeIfPresent(String.self, forKey: .model)) ?? "?"
        search = (try? c.decodeIfPresent(FlexBool.self, forKey: .search))?.value ?? false
        input = (try? c.decodeIfPresent(String.self, forKey: .input)) ?? ""
        output = try? c.decodeIfPresent(String.self, forKey: .output)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        ms = try? c.decodeIfPresent(Int.self, forKey: .ms)
        systemPrompt = try? c.decodeIfPresent(String.self, forKey: .systemPrompt)
    }

    enum CodingKeys: String, CodingKey { case id, ts, cycle, agent, model, search, input, output, error, ms, systemPrompt }
}

/// Flattens a JSON document into readable rows, e.g. {"maxPositionPct":{"short":5}} -> ("Max position pct · short", "5").
public enum JSONRows {
    public static func rows(_ json: String) -> [(label: String, value: String)] {
        guard let data = json.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return []
        }
        var out: [(String, String)] = []
        flatten(obj, path: [], into: &out)
        return out.map { (label: $0.0, value: $0.1) }
    }

    static func flatten(_ obj: Any, path: [String], into out: inout [(String, String)]) {
        if let dict = obj as? [String: Any] {
            for key in dict.keys.sorted() { flatten(dict[key]!, path: path + [humanize(key)], into: &out) }
        } else if let list = obj as? [Any], list.allSatisfy({ !($0 is [String: Any]) && !($0 is [Any]) }) {
            out.append((path.joined(separator: " · "), list.map(scalar).joined(separator: ", ")))
        } else if let list = obj as? [Any] {
            for (i, item) in list.enumerated() { flatten(item, path: path + ["\(i + 1)"], into: &out) }
        } else {
            out.append((path.joined(separator: " · "), scalar(obj)))
        }
    }

    static func scalar(_ v: Any) -> String {
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "yes" : "no" }
            return n.stringValue
        }
        if v is NSNull { return "–" }
        return "\(v)"
    }

    /// "maxPositionPct" / "max_position_pct" -> "Max position pct"
    static func humanize(_ key: String) -> String {
        var words: [String] = []
        var current = ""
        for ch in key {
            if ch == "_" || ch == "-" || ch == " " {
                if !current.isEmpty { words.append(current); current = "" }
            } else if ch.isUppercase, !current.isEmpty {
                words.append(current)
                current = String(ch).lowercased()
            } else {
                current.append(ch)
            }
        }
        if !current.isEmpty { words.append(current) }
        let text = words.joined(separator: " ")
        return text.prefix(1).uppercased() + text.dropFirst()
    }
}
