import Foundation

/// The bot team. Mirrors graph/team.yaml; keep the two in sync when the team changes.
public struct TeamMember: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var number: Int
    public var role: String
    public var horizon: String
    public var reportsTo: [String]
    public var job: String
    public var hasVeto: Bool

    public init(id: String, name: String, number: Int, role: String, horizon: String, reportsTo: [String], job: String, hasVeto: Bool = false) {
        self.id = id
        self.name = name
        self.number = number
        self.role = role
        self.horizon = horizon
        self.reportsTo = reportsTo
        self.job = job
        self.hasVeto = hasVeto
    }
}

public enum Team {
    public static let owner = "human"

    public static let members: [TeamMember] = [
        TeamMember(id: "nova", name: "Nova", number: 1, role: "Head trader", horizon: "All", reportsTo: ["human"],
                   job: "Sets allocation across horizons, approves or rejects proposals, writes the daily report."),
        TeamMember(id: "orin", name: "Orin", number: 2, role: "Market scanner", horizon: "Short", reportsTo: ["vela"],
                   job: "Sweeps every Cauldron token for volume spikes, new pools, TVL changes and breakouts."),
        TeamMember(id: "vela", name: "Vela", number: 3, role: "Research", horizon: "Medium / long", reportsTo: ["nova"],
                   job: "Turns signals into theses and writes trade proposals with entry, target, stop and size."),
        TeamMember(id: "kade", name: "Kade", number: 4, role: "Risk officer", horizon: "All", reportsTo: ["nova"],
                   job: "Rug checks, liquidity and slippage checks, position and drawdown limits.", hasVeto: true),
        TeamMember(id: "rune", name: "Rune", number: 5, role: "Executor", horizon: "Short", reportsTo: ["nova"],
                   job: "Turns approved orders into quotes, verifies transactions and confirms fills."),
        TeamMember(id: "zara", name: "Zara", number: 6, role: "Journal & alerts", horizon: "All", reportsTo: ["nova", "human"],
                   job: "Logs every outcome, computes win rate, writes post-mortems and lessons."),
    ]

    /// The 24/7 loop, in order.
    public static let loop = ["orin", "vela", "kade", "nova", "rune", "zara"]

    public static func member(_ id: String) -> TeamMember? {
        members.first { $0.id == id.lowercased() }
    }

    public static func displayName(_ id: String) -> String {
        member(id)?.name ?? id.capitalized
    }

    /// Direct reports of `id` (primary reporting line only, so Zara appears once, under Nova).
    public static func reports(of id: String) -> [TeamMember] {
        members.filter { $0.reportsTo.first == id }
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
