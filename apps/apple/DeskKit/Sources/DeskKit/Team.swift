import Foundation

/// One agent in the team graph. The live graph comes from GET /api/team (stored in D1);
/// `Team.fallback` is only used until that loads or when the desk can't be reached.
public struct TeamMember: Decodable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var number: Int
    public var role: String
    public var horizons: [String]
    public var reportsTo: [String]
    public var hasVeto: Bool
    public var tools: [String]
    /// Latest status as reported with /api/team.
    public var status: String?
    public var statusAt: Date?

    public init(id: String, name: String, number: Int, role: String, horizons: [String], reportsTo: [String],
                hasVeto: Bool = false, tools: [String] = [], status: String? = nil, statusAt: Date? = nil) {
        self.id = id
        self.name = name
        self.number = number
        self.role = role
        self.horizons = horizons
        self.reportsTo = reportsTo
        self.hasVeto = hasVeto
        self.tools = tools
        self.status = status
        self.statusAt = statusAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id).lowercased()
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? id.capitalized
        number = 0
        role = (try? c.decodeIfPresent(String.self, forKey: .role)) ?? ""
        if let list = try? c.decodeIfPresent([String].self, forKey: .horizons) {
            horizons = list
        } else if let one = try? c.decodeIfPresent(String.self, forKey: .horizon) {
            horizons = one == "all" ? ["short", "medium", "long"] : [one]
        } else {
            horizons = []
        }
        if let list = try? c.decodeIfPresent([String].self, forKey: .reportsTo) {
            reportsTo = list
        } else if let one = try? c.decodeIfPresent(String.self, forKey: .reportsTo) {
            reportsTo = [one]
        } else {
            reportsTo = []
        }
        hasVeto = (try? c.decodeIfPresent(FlexBool.self, forKey: .veto))?.value ?? false
        tools = (try? c.decodeIfPresent([String].self, forKey: .tools)) ?? []
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        statusAt = try? c.decodeIfPresent(Date.self, forKey: .statusAt)
    }

    enum CodingKeys: String, CodingKey { case id, name, role, horizons, horizon, reportsTo, veto, tools, status, statusAt }

    /// "Short", "Medium / long" or "All".
    public var horizonLabel: String {
        if horizons.count >= 3 || horizons.isEmpty { return "All" }
        let text = horizons.joined(separator: " / ")
        return text.prefix(1).uppercased() + text.dropFirst()
    }
}

public enum Team {
    /// Mirrors seed/team.json, for use before /api/team has loaded.
    public static let fallback = TeamRoster(owner: "human", loop: ["orin", "vela", "kade", "nova", "rune", "zara"], members: [
        TeamMember(id: "nova", name: "Nova", number: 1, role: "Head trader / portfolio manager", horizons: ["short", "medium", "long"], reportsTo: ["human"]),
        TeamMember(id: "orin", name: "Orin", number: 2, role: "Market scanner", horizons: ["short"], reportsTo: ["vela"]),
        TeamMember(id: "vela", name: "Vela", number: 3, role: "Research analyst", horizons: ["medium", "long"], reportsTo: ["nova"]),
        TeamMember(id: "kade", name: "Kade", number: 4, role: "Risk officer", horizons: ["short", "medium", "long"], reportsTo: ["nova"], hasVeto: true),
        TeamMember(id: "rune", name: "Rune", number: 5, role: "Executor", horizons: ["short"], reportsTo: ["nova"]),
        TeamMember(id: "zara", name: "Zara", number: 6, role: "Journal, learning and alerts", horizons: ["short", "medium", "long"], reportsTo: ["nova", "human"]),
    ])

    /// Display name for an agent id where no roster is at hand (ids are lowercase names).
    public static func displayName(_ id: String) -> String {
        fallback.member(id)?.name ?? id.capitalized
    }
}

/// A team member joined with the latest status the Worker reported for it.
public struct AgentCard: Identifiable, Hashable, Sendable {
    public var member: TeamMember
    public var status: String?
    public var updatedAt: Date?
    public var lastEvent: DeskEvent?

    public var id: String { member.id }
}
