import Foundation

/// What the iOS Live Activity shows while the desk trades real money. Plain data so the widget
/// extension and the tests don't need the store; the app builds it from DeskState on every refresh.
public struct LiveActivityState: Codable, Hashable, Sendable {
    public var totalPusd: Double?
    public var pnlPusd: Double?
    public var pnlPct: Double?
    public var dayPusd: Double?
    public var frozen: Bool
    public var halted: Bool
    public var cycle: Int?
    public var running: Bool
    public var step: String?
    public var nextRunAt: Date?
    public var overdue: Bool
    public var updatedAt: Date

    public init(totalPusd: Double? = nil, pnlPusd: Double? = nil, pnlPct: Double? = nil, dayPusd: Double? = nil,
                frozen: Bool = false, halted: Bool = false, cycle: Int? = nil, running: Bool = false, step: String? = nil,
                nextRunAt: Date? = nil, overdue: Bool = false, updatedAt: Date = Date()) {
        self.totalPusd = totalPusd
        self.pnlPusd = pnlPusd
        self.pnlPct = pnlPct
        self.dayPusd = dayPusd
        self.frozen = frozen
        self.halted = halted
        self.cycle = cycle
        self.running = running
        self.step = step
        self.nextRunAt = nextRunAt
        self.overdue = overdue
        self.updatedAt = updatedAt
    }

    /// Nil unless the desk is trading live.
    public init?(state: DeskState, dayChange: Double?, now: Date = Date()) {
        guard state.mode == .live else { return nil }
        self.init(totalPusd: state.totalPusd, pnlPusd: state.pnlAllPusd, pnlPct: state.pnlAllPct, dayPusd: dayChange,
                  frozen: state.frozen, halted: state.halted, cycle: state.runner?.cycle, running: state.cycleRunning,
                  step: state.step, nextRunAt: state.runner?.nextRunAt,
                  overdue: !state.cycleRunning && state.runner?.isOverdue(now: now) == true,
                  updatedAt: state.updatedAt ?? now)
    }

    /// "Cycle 49 · Vela research", "Cycle 49 done · next run overdue (was due 19:35 UTC)".
    /// The countdown to the next run is drawn by the widget so it ticks without updates.
    public var cycleLine: String {
        let head = cycle.map { "Cycle \($0)" } ?? "Cauldron Trader"
        if running { return head + (step.map { " · \($0)" } ?? " running") }
        if overdue { return head + " done · next run overdue" + (nextRunAt.map { " (was due \(RunnerStatus.clock($0)))" } ?? "") }
        return head + " done"
    }

    /// When the lock screen should grey the activity out: a while after the next run should have reported.
    public var staleDate: Date {
        let base = max(nextRunAt ?? updatedAt, updatedAt)
        return base.addingTimeInterval(20 * 60)
    }
}
