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

        lastError = firstError?.localizedDescription
        if firstError == nil || state != nil { lastRefresh = Date() }
    }

    /// Refreshes on a timer until the calling task is cancelled (e.g. a view's .task).
    public func poll(every seconds: Double) async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(seconds))
        }
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
        return Team.members.map { m in
            AgentCard(member: m,
                      status: statuses[m.id]?.status,
                      updatedAt: statuses[m.id]?.updatedAt,
                      lastEvent: events.first { $0.agent.lowercased() == m.id })
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
}

private func capture<T>(_ body: () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await body()) } catch { return .failure(error) }
}
