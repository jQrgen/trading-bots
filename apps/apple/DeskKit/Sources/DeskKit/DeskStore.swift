import Foundation
import Observation

/// Everything the app shows, refreshed from a DeskService. Views read it; nothing here writes to the desk.
@MainActor
@Observable
public final class DeskStore {
    public private(set) var state: DeskState?
    public private(set) var events: [DeskEvent] = []
    public private(set) var snapshots: [Snapshot] = []
    public private(set) var trades: [Trade] = []
    public private(set) var positions: [Position] = []
    public private(set) var journal: [JournalEntry] = []
    public private(set) var lessons: [Lesson] = []
    public private(set) var team: TeamRoster = Team.fallback
    public private(set) var knowledge: [KnowledgeEntry] = []
    public private(set) var scorecard: Scorecard?
    public private(set) var proposals: [Proposal] = []
    public private(set) var tokens: [TokenSeen] = []
    public private(set) var research: [ResearchNote] = []
    public private(set) var sentiment: [SentimentReading] = []
    public private(set) var launchpad: [LaunchpadSale] = []
    public private(set) var files: [BotFile] = []
    public private(set) var liquidity: [LiquidityPosition] = []
    public private(set) var reviews: [TradeReview] = []
    /// Latest tick per token, largest pools first.
    public private(set) var markets: [MarketTick] = []
    /// Daily-ish scorecards for the last 90 days, oldest first.
    public private(set) var scorecardHistory: [Scorecard] = []

    public private(set) var isLoading = false
    public private(set) var lastRefresh: Date?
    public private(set) var lastError: String?

    /// Balance chart range in days. Change it with setChartDays(_:).
    public private(set) var chartDays = 7

    public static let maxEvents = 600

    public private(set) var service: any DeskService

    public init(service: any DeskService) {
        self.service = service
    }

    /// Swap the backend (e.g. after the URL changes in Settings) and start from scratch.
    public func use(_ service: any DeskService) async {
        self.service = service
        state = nil
        events = []
        snapshots = []
        trades = []
        positions = []
        journal = []
        lessons = []
        team = Team.fallback
        knowledge = []
        scorecard = nil
        proposals = []
        tokens = []
        research = []
        sentiment = []
        launchpad = []
        files = []
        liquidity = []
        reviews = []
        markets = []
        scorecardHistory = []
        lastRefresh = nil
        lastError = nil
        await refresh()
    }

    /// Refreshes everything. A failing endpoint keeps its previous data and reports the first error.
    public func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        let service = self.service
        let afterId = events.first?.id ?? 0
        let days = chartDays
        var firstError: Error?
        func note(_ error: Error) { if firstError == nil { firstError = error } }

        async let stateTask = capture { try await service.state() }
        async let eventsTask = capture { try await service.events(after: afterId, limit: 300) }
        async let snapshotsTask = capture { try await service.snapshots(days: days) }
        async let tradesTask = capture { try await service.trades() }
        async let positionsTask = capture { try await service.positions() }
        async let journalTask = capture { try await service.journal() }
        async let lessonsTask = capture { try await service.lessons() }
        async let teamTask = capture { try await service.team() }
        async let knowledgeTask = capture { try await service.knowledge() }
        async let scorecardTask = capture { try await service.scorecard() }
        async let proposalsTask = capture { try await service.proposals(limit: 200) }
        async let tokensTask = capture { try await service.tokens() }
        async let researchTask = capture { try await service.research(token: nil) }
        async let sentimentTask = capture { try await service.sentiment(subject: nil) }
        async let launchpadTask = capture { try await service.launchpad() }
        async let filesTask = capture { try await service.files() }
        async let liquidityTask = capture { try await service.liquidity() }
        async let reviewsTask = capture { try await service.reviews() }
        async let marketsTask = capture { try await service.markets() }
        async let scorecardsTask = capture { try await service.scorecards(days: 90) }

        switch await stateTask { case .success(let v): state = v; case .failure(let e): note(e) }
        switch await eventsTask { case .success(let v): merge(events: v); case .failure(let e): note(e) }
        switch await snapshotsTask {
        case .success(let v): if days == chartDays { snapshots = v.sorted { $0.ts < $1.ts } }
        case .failure(let e): note(e)
        }
        switch await tradesTask { case .success(let v): trades = v.sorted { $0.ts > $1.ts }; case .failure(let e): note(e) }
        switch await positionsTask { case .success(let v): positions = v; case .failure(let e): note(e) }
        switch await journalTask { case .success(let v): journal = v.sorted { $0.ts > $1.ts }; case .failure(let e): note(e) }
        switch await lessonsTask { case .success(let v): lessons = v.sorted { $0.ts > $1.ts }; case .failure(let e): note(e) }
        switch await teamTask { case .success(let v): if !v.members.isEmpty { team = v }; case .failure(let e): note(e) }
        switch await knowledgeTask { case .success(let v): knowledge = v; case .failure(let e): note(e) }
        switch await scorecardTask { case .success(let v): scorecard = v; case .failure(let e): note(e) }
        switch await proposalsTask { case .success(let v): proposals = v.sorted { $0.ts > $1.ts }; case .failure(let e): note(e) }
        switch await tokensTask { case .success(let v): tokens = v.sorted { $0.firstSeen > $1.firstSeen }; case .failure(let e): note(e) }
        switch await researchTask { case .success(let v): research = v.sorted { $0.ts > $1.ts }; case .failure(let e): note(e) }
        switch await sentimentTask { case .success(let v): sentiment = v.sorted { $0.ts > $1.ts }; case .failure(let e): note(e) }
        switch await launchpadTask { case .success(let v): launchpad = v.sorted { $0.firstSeen > $1.firstSeen }; case .failure(let e): note(e) }
        switch await filesTask { case .success(let v): files = v.sorted { $0.updatedAt > $1.updatedAt }; case .failure(let e): note(e) }
        switch await liquidityTask { case .success(let v): liquidity = v; case .failure(let e): note(e) }
        switch await reviewsTask { case .success(let v): reviews = v.sorted { $0.ts > $1.ts }; case .failure(let e): note(e) }
        switch await marketsTask { case .success(let v): markets = v; case .failure(let e): note(e) }
        switch await scorecardsTask {
        case .success(let v): scorecardHistory = v.sorted { ($0.ts ?? .distantPast) < ($1.ts ?? .distantPast) }
        case .failure(let e): note(e)
        }

        lastError = firstError?.localizedDescription
        if firstError == nil || state != nil { lastRefresh = Date() }
    }

    /// Refreshes on a timer until the calling task is cancelled. The interval is re-read each round so Settings changes apply.
    public func poll(every seconds: @escaping () -> Double) async {
        var nextFull = Date.distantPast
        while !Task.isCancelled {
            if Date() >= nextFull {
                await refresh()
                nextFull = Date().addingTimeInterval(max(seconds(), 5))
            } else {
                await refreshLive()
            }
            try? await Task.sleep(for: .seconds(4))
        }
    }

    /// Role and banner only. The full desk still refreshes on the slower timer.
    public func refreshLive() async {
        guard !isLoading else { return }
        if let v = try? await service.state() { state = v }
    }

    public func setChartDays(_ days: Int) async {
        guard days != chartDays else { return }
        chartDays = days
        await loadSnapshots()
    }

    func loadSnapshots() async {
        let days = chartDays
        if let v = try? await service.snapshots(days: days), days == chartDays {
            snapshots = v.sorted { $0.ts < $1.ts }
        }
    }

    func merge(events fresh: [DeskEvent]) {
        guard !fresh.isEmpty else { return }
        var seen = Set(events.map(\.id))
        let added = fresh.filter { seen.insert($0.id).inserted }
        events = Array((added + events).sorted { $0.id > $1.id }.prefix(Self.maxEvents))
    }

    // MARK: - Derived values for the views

    /// The six agents with their latest status and last thing they said.
    public var agentCards: [AgentCard] {
        let statuses = Dictionary((state?.agents ?? []).map { ($0.agent.lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
        let runningId = state?.cycleRunning == true ? state?.activeRole?.lowercased() : nil
        return team.members.map { m in
            let on = runningId == m.id
            return AgentCard(member: m,
                             status: statuses[m.id]?.status ?? m.status,
                             updatedAt: on ? state?.activeSince : (statuses[m.id]?.updatedAt ?? m.statusAt),
                             lastEvent: events.first { $0.agent.lowercased() == m.id },
                             isRunning: on,
                             cycle: state?.runner?.cycle,
                             activeSince: on ? state?.activeSince : nil)
        }
    }

    public var openPositions: [Position] {
        // /api/state marks open positions to market, so prefer it over the raw table.
        if let state, !state.positions.isEmpty { return state.positions }
        return positions.filter(\.isOpen)
    }

    public var closedPositions: [Position] {
        positions.filter { !$0.isOpen }.sorted { ($0.closedAt ?? .distantPast) > ($1.closedAt ?? .distantPast) }
    }

    /// Change in total value over the last `hours`, from the snapshot history.
    public func change(overHours hours: Double, now: Date = Date()) -> Double? {
        guard let latest = state?.totalPusd ?? snapshots.last?.totalPusd else { return nil }
        let cutoff = now.addingTimeInterval(-hours * 3600)
        guard let base = snapshots.last(where: { $0.ts <= cutoff }) ?? snapshots.first, base.ts <= now else { return nil }
        return latest - base.totalPusd
    }

    /// Change over the range shown in the chart.
    public var chartChange: Double? {
        guard let first = snapshots.first, let last = snapshots.last, snapshots.count > 1 else { return nil }
        return last.totalPusd - first.totalPusd
    }

    public var isLive: Bool { state?.mode == .live }

    /// Knowledge documents other than agent role files, which are shown with each agent.
    public var playbook: [KnowledgeEntry] {
        knowledge.filter { $0.roleAgent == nil }
    }

    public func roleDocument(for agent: String) -> KnowledgeEntry? {
        knowledge.first { $0.roleAgent == agent }
    }

    /// The latest reading for the BCH market and for Cauldron, in that order, when there is one.
    public var marketMood: [SentimentReading] {
        ["bch", "cauldron"].compactMap { subject in sentiment.first { $0.subject == subject } }
    }

    public var openLiquidity: [LiquidityPosition] { liquidity.filter(\.isOpen) }

    public var closedLiquidity: [LiquidityPosition] {
        liquidity.filter { !$0.isOpen }.sorted { ($0.closedAt ?? $0.openedAt) > ($1.closedAt ?? $1.openedAt) }
    }

    /// Zara's review of a closed position, once she has written it.
    public func review(of positionId: Int) -> TradeReview? {
        reviews.first { $0.positionId == positionId }
    }

    /// Research notes about one token, newest first.
    public func notes(about tokenId: String) -> [ResearchNote] {
        research.filter { $0.tokenId == tokenId }
    }

    /// Sentiment readings about one token, newest first.
    public func mood(about tokenId: String) -> [SentimentReading] {
        sentiment.filter { $0.subject == "token" && $0.tokenId == tokenId }
    }
}

private func capture<T>(_ body: () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await body()) } catch { return .failure(error) }
}
