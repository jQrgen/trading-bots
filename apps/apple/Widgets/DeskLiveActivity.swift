import ActivityKit
import DeskKit
import SwiftUI
import WidgetKit

@main
struct DeskWidgets: WidgetBundle {
    var body: some Widget {
        DeskLiveActivity()
    }
}

/// Lock screen and Dynamic Island while the desk trades real money. Read-only, like the app.
struct DeskLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DeskActivityAttributes.self) { context in
            LockScreenView(name: context.attributes.name, state: context.state, isStale: context.isStale)
                .padding(16)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let s = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        LiveBadge(frozen: s.frozen, halted: s.halted)
                        Text(Format.pusd(s.totalPusd)).font(.title3.weight(.bold)).monospacedDigit()
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("P&L").font(.caption2).foregroundStyle(.secondary)
                        Text(Format.signed(s.pnlPusd)).font(.title3.weight(.bold)).monospacedDigit().foregroundStyle(pnlColor(s.pnlPusd))
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    CycleLine(state: s, isStale: context.isStale)
                }
            } compactLeading: {
                HStack(spacing: 4) {
                    Circle().fill(s.frozen ? Color.purple : Color.red).frame(width: 8, height: 8)
                    Text(Format.pusd(s.totalPusd, decimals: 0)).monospacedDigit()
                }
            } compactTrailing: {
                Text(Format.signed(s.pnlPusd)).monospacedDigit().foregroundStyle(pnlColor(s.pnlPusd))
            } minimal: {
                Circle().fill(s.frozen ? Color.purple : Color.red).frame(width: 10, height: 10)
            }
        }
    }
}

private struct LockScreenView: View {
    var name: String
    var state: LiveActivityState
    var isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                LiveBadge(frozen: state.frozen, halted: state.halted)
                Text(name).font(.subheadline.weight(.semibold))
                Spacer()
                Text(state.updatedAt, style: .time).font(.caption).foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(Format.pusd(state.totalPusd)).font(.title.weight(.bold)).monospacedDigit()
                Text("PUSD").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    Text("\(Format.signed(state.pnlPusd)) (\(Format.signedPct(state.pnlPct)))")
                        .font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(pnlColor(state.pnlPusd))
                    Text("24h \(Format.signed(state.dayPusd))").font(.caption).monospacedDigit().foregroundStyle(pnlColor(state.dayPusd))
                }
            }
            CycleLine(state: state, isStale: isStale)
        }
        .foregroundStyle(.white)
    }
}

private struct CycleLine: View {
    var state: LiveActivityState
    var isStale: Bool

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: state.running ? "bolt.fill" : state.overdue ? "clock.badge.exclamationmark" : "clock")
            Text(state.cycleLine).lineLimit(1)
            if !state.running, !state.overdue, let next = state.nextRunAt, next > Date() {
                Text("· next in")
                Text(timerInterval: Date()...next, countsDown: true).monospacedDigit().frame(maxWidth: 48, alignment: .leading)
            }
            Spacer(minLength: 0)
            if isStale { Text("not updated").font(.caption2) }
        }
        .font(.caption)
        .foregroundStyle(state.running ? Color.green : state.overdue || isStale ? Color.orange : Color.secondary)
    }
}

private struct LiveBadge: View {
    var frozen: Bool
    var halted: Bool

    var body: some View {
        Text(frozen ? "FROZEN" : halted ? "HALTED" : "LIVE")
            .font(.caption2.weight(.heavy))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(frozen ? Color.purple : halted ? Color.orange : Color.red))
            .foregroundStyle(.white)
    }
}

private func pnlColor(_ value: Double?) -> Color {
    guard let value else { return .secondary }
    return value > 0 ? .green : value < 0 ? .red : .secondary
}
