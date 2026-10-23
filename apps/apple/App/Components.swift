import SwiftUI
import DeskKit

// MARK: - Platform metrics

enum Metrics {
    #if os(tvOS)
    static let spacing: CGFloat = 40
    static let padding: CGFloat = 32
    static let tileMinWidth: CGFloat = 340
    static let cardMinWidth: CGFloat = 560
    static let chartHeight: CGFloat = 380
    static let heroFont: Font = .system(size: 96, weight: .bold, design: .rounded)
    #else
    static let spacing: CGFloat = 16
    static let padding: CGFloat = 16
    static let tileMinWidth: CGFloat = 150
    static let cardMinWidth: CGFloat = 320
    static let chartHeight: CGFloat = 220
    static let heroFont: Font = .system(size: 44, weight: .bold, design: .rounded)
    #endif
}

// MARK: - Colours

extension Color {
    static let up = Color.green
    static let down = Color.red

    static func pnl(_ value: Double?) -> Color {
        guard let value else { return .secondary }
        return value > 0 ? .up : value < 0 ? .down : .secondary
    }

    static func agent(_ id: String) -> Color {
        switch id.lowercased() {
        case "nova": .purple
        case "orin": .blue
        case "vela": .teal
        case "kade": .orange
        case "rune": .green
        case "zara": .pink
        default: .gray
        }
    }
}

/// Styling for the event kinds the Worker logs (see Ledger.log calls in src/loop.ts).
enum EventStyle {
    static func symbol(_ kind: String) -> String {
        switch kind {
        case "start": "play.circle"
        case "scan": "dot.radiowaves.left.and.right"
        case "signal": "bolt.fill"
        case "rug-check": "magnifyingglass"
        case "proposal": "doc.text"
        case "risk-pass": "checkmark.shield"
        case "risk-fail": "xmark.shield"
        case "risk": "shield"
        case "decision": "checkmark.seal"
        case "fill": "arrow.left.arrow.right"
        case "skip": "forward"
        case "journal": "book"
        case "error": "exclamationmark.triangle"
        case "admin": "person.badge.key"
        case "deploy": "shippingbox"
        default: "text.bubble"
        }
    }

    static func color(_ kind: String) -> Color {
        switch kind {
        case "risk-pass", "fill": .green
        case "risk-fail", "error": .red
        case "signal": .yellow
        case "decision", "admin": .purple
        case "risk": .orange
        default: .secondary
        }
    }
}

// MARK: - Building blocks

struct Card<Content: View>: View {
    var title: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                Text(title).font(.headline).foregroundStyle(.secondary)
            }
            content
        }
        .padding(Metrics.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.primary.opacity(0.06)))
        .tvFocusable()
    }
}

struct StatTile: View {
    var title: String
    var value: String
    var detail: String?
    var tint: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
            Text(value).font(.title2.weight(.semibold)).monospacedDigit().foregroundStyle(tint)
                .contentTransition(.numericText())
            if let detail {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(Metrics.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.primary.opacity(0.06)))
        .tvFocusable()
    }
}

struct ModeBadge: View {
    var mode: TradingMode
    var halted: Bool
    var frozen = false

    var body: some View {
        HStack(spacing: 6) {
            Text(mode == .live ? "LIVE" : "PAPER")
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(mode == .live ? Color.red : Color.blue))
                .foregroundStyle(.white)
            if halted {
                Text("HALTED")
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(Color.orange))
                    .foregroundStyle(.white)
            }
            if frozen {
                Text("FROZEN")
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(Color.purple))
                    .foregroundStyle(.white)
            }
        }
        .font(.caption.weight(.bold))
    }
}

struct AgentAvatar: View {
    var id: String
    var size: CGFloat = 32

    var body: some View {
        Circle()
            .fill(Color.agent(id).gradient)
            .frame(width: size, height: size)
            .overlay(Text(String(Team.displayName(id).prefix(1))).font(.system(size: size * 0.45, weight: .bold)).foregroundStyle(.white))
            .accessibilityHidden(true)
    }
}

struct EventRow: View {
    var event: DeskEvent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentAvatar(id: event.agent, size: 28)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(Team.displayName(event.agent)).font(.subheadline.weight(.semibold))
                    Label(event.kind, systemImage: EventStyle.symbol(event.kind))
                        .font(.caption)
                        .foregroundStyle(EventStyle.color(event.kind))
                    Spacer(minLength: 0)
                    Text(Format.time(event.ts)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                Text(event.message).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct TradeRow: View {
    var trade: Trade

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: trade.isBuy ? "arrow.down.left.circle.fill" : "arrow.up.right.circle.fill")
                .font(.title2)
                .foregroundStyle(trade.isBuy ? Color.up : Color.down)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(trade.sideLabel) \(trade.symbol)").font(.headline)
                Text(Format.dateTime(trade.ts) + (trade.mode == .paper ? " · paper" : trade.txid != nil ? " · on-chain" : ""))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(Format.pusd(trade.pusd)) PUSD").font(.body.weight(.medium)).monospacedDigit()
                if let impact = trade.impactPct {
                    Text("impact \(Format.pusd(impact))%\(trade.estimated ? "*" : "")")
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct PositionRow: View {
    var position: Position

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(position.symbol).font(.headline)
                Text([position.horizon, position.isOpen ? nil : position.closeReason].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(Format.pusd(position.exitPusd ?? position.valuePusd ?? position.costPusd)) PUSD")
                    .font(.body.weight(.medium)).monospacedDigit()
                Text("\(Format.signed(position.pnlPusd)) (\(Format.signedPct(position.displayPnlPct)))")
                    .font(.caption).monospacedDigit()
                    .foregroundStyle(Color.pnl(position.pnlPusd))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Shown at the top of screens when using sample data or when the last refresh failed.
struct StatusBanner: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        if store.service is DemoDesk {
            banner("Showing demo data. Choose \"Use the live desk\" in Settings to see the real bots.", symbol: "sparkles", tint: .blue)
        } else if let error = store.lastError {
            banner(error, symbol: "exclamationmark.triangle.fill", tint: .orange)
        }
        if let runner = store.state?.runner {
            banner(runner.summary, symbol: runner.isOverdue() ? "clock.badge.exclamationmark" : "clock.arrow.circlepath",
                   tint: runner.isOverdue() ? .orange : .teal)
        }
        GrokBotBanner()
    }

    private func banner(_ text: String, symbol: String, tint: Color) -> some View {
        Label(text, systemImage: symbol)
            .font(.callout)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(tint.opacity(0.15)))
            .tvFocusable()
    }
}

// MARK: - tvOS focus

extension View {
    /// Plain on iOS and macOS; the lifting card style on Apple TV.
    func tileButtonStyle() -> some View {
        #if os(tvOS)
        buttonStyle(.card)
        #else
        buttonStyle(.plain)
        #endif
    }
}

extension View {
    /// On Apple TV, content can only scroll to views that take focus, so cards opt in and grow slightly when focused.
    func tvFocusable() -> some View {
        #if os(tvOS)
        modifier(TVFocus())
        #else
        self
        #endif
    }
}

#if os(tvOS)
private struct TVFocus: ViewModifier {
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .focusable()
            .focused($focused)
            .scaleEffect(focused ? 1.03 : 1)
            .shadow(color: .black.opacity(focused ? 0.35 : 0), radius: 18, y: 8)
            .animation(.easeOut(duration: 0.15), value: focused)
    }
}
#endif
