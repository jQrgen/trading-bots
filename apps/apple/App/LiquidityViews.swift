import SwiftUI
import DeskKit

/// One paper liquidity position: what went in, fees earned, impermanent loss and where it stands.
struct LiquidityRow: View {
    var position: LiquidityPosition

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(position.symbol) pool").font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.signed(position.pnlPusd)).monospacedDigit().foregroundStyle(Color.pnl(position.pnlPusd))
                Text(Format.signedPct(position.pnlPct)).font(.caption).monospacedDigit().foregroundStyle(Color.pnl(position.pnlPusd))
            }
        }
    }

    private var detail: String {
        var parts = ["\(Format.pusd(position.depositPusd)) in", "fees \(Format.pusd(position.feesPusd))"]
        if let il = position.ilPct { parts.append("IL \(Format.signedPct(il))") }
        if !position.isOpen, let reason = position.closeReason { parts.append(reason) }
        return parts.joined(separator: " · ")
    }
}

struct LiquidityDetailView: View {
    var position: LiquidityPosition

    var body: some View {
        List {
            Section {
                LabeledContent("Status", value: position.status)
                if let signal = position.signal { LabeledContent("Signal", value: signal) }
                LabeledContent("Deposit", value: Format.pusd(position.depositPusd) + " PUSD")
                LabeledContent("Fees earned (est.)", value: Format.pusd(position.feesPusd) + " PUSD")
                if let v = position.isOpen ? position.valuePusd : (position.exitPusd ?? position.valuePusd) {
                    LabeledContent(position.isOpen ? "Value now" : "Exit", value: Format.pusd(v) + " PUSD")
                }
                LabeledContent("P&L") {
                    Text("\(Format.signed(position.pnlPusd)) (\(Format.signedPct(position.pnlPct)))")
                        .foregroundStyle(Color.pnl(position.pnlPusd))
                }
                if let il = position.ilPct {
                    LabeledContent("Impermanent loss", value: Format.signedPct(il))
                }
                if let stop = position.stopPct {
                    LabeledContent("Stop", value: "-\(Format.pusd(stop, decimals: 0))%")
                }
                LabeledContent("Opened", value: Format.dateTime(position.openedAt))
                if let closed = position.closedAt { LabeledContent("Closed", value: Format.dateTime(closed)) }
                if let reason = position.closeReason { LabeledContent("Close reason", value: reason) }
            } footer: {
                Text("Cauldron pool. In live mode the position is on chain and the value is marked from it. Fee figures are estimates; impermanent loss is against just holding the deposit.")
            }
            if let thesis = position.thesis, !thesis.isEmpty {
                Section("Thesis") { Text(thesis) }
            }
        }
        .navigationTitle("\(position.symbol) pool")
    }
}

/// Zara's grade of a closed trade: process (clean, minor, major) and outcome, kept apart.
struct ReviewRow: View {
    var review: TradeReview
    var showSymbol = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if showSymbol { Text(review.symbol).font(.headline) }
                Text(processLabel)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(processColor.opacity(0.18), in: Capsule())
                    .foregroundStyle(processColor)
                Spacer()
                Text(outcome).font(.callout).monospacedDigit().foregroundStyle(Color.pnl(review.outcomePusd))
            }
            Text(review.finding).font(.callout).foregroundStyle(.secondary)
            if let overshoot = review.stopOvershootPct, overshoot > 0 {
                Text("Stop overshoot \(Format.pusd(overshoot, decimals: 1))%").font(.caption).foregroundStyle(.orange)
            }
        }
        .tvFocusable()
    }

    private var processLabel: String {
        switch review.process {
        case "clean": "Clean process"
        case "minor": "Minor slip" + (review.breakStage.map { " at \($0)" } ?? "")
        case "major": "Major break" + (review.breakStage.map { " at \($0)" } ?? "")
        default: review.process.capitalized
        }
    }

    private var processColor: Color {
        switch review.process {
        case "clean": .up
        case "minor": .orange
        case "major": .down
        default: .secondary
        }
    }

    private var outcome: String {
        let r = review.outcomeR.map { " (\(Format.signed($0, decimals: 1))R)" } ?? ""
        return Format.signed(review.outcomePusd) + r
    }
}

/// When the Grok Bot app last reached the desk, and a warning if its calls are being rejected.
struct GrokBotBanner: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        if !(store.service is DemoDesk), let bot = store.state?.grokBot {
            if let failure = bot.currentFailure {
                Label("Grok Bot's last call was rejected \(Format.relative(failure.ts)): \(failure.reason)", systemImage: "key.slash")
                    .font(.callout)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.orange.opacity(0.15)))
                    .tvFocusable()
            } else if bot.lastSeen == nil {
                Label("Grok Bot hasn't connected yet. Paste the desk's /grok guide into the Grok app to start the team.", systemImage: "bolt.horizontal.circle")
                    .font(.callout)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.blue.opacity(0.15)))
                    .tvFocusable()
            }
        }
    }
}

/// A transaction id or address that opens in Nordic Crypto's explorer (shown as text on Apple TV, which has no browser).
struct ExplorerLink: View {
    var text: String

    var body: some View {
        #if os(tvOS)
        Text(text).font(.system(.footnote, design: .monospaced)).tvFocusable()
        #else
        if let url = Explorer.url(text) {
            Link(destination: url) {
                Label {
                    Text(text).font(.system(.footnote, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                } icon: {
                    Image(systemName: "arrow.up.right.square")
                }
            }
        } else {
            Text(text).font(.system(.footnote, design: .monospaced))
        }
        #endif
    }
}

/// The desk's own wallet, read-only: whether it's trading real money, its address and what it holds.
struct WalletCard: View {
    var wallet: WalletInfo

    var body: some View {
        Card(title: "Wallet") {
            HStack(spacing: 6) {
                Text(wallet.mode == .live ? "LIVE" : "NOT LIVE")
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(wallet.mode == .live ? Color.red : Color.secondary.opacity(0.3)))
                    .foregroundStyle(wallet.mode == .live ? Color.white : Color.primary)
                if wallet.frozen {
                    Text("FROZEN")
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.purple))
                        .foregroundStyle(.white)
                }
                Spacer()
                if let since = wallet.liveSince, wallet.mode == .live {
                    Text("since \(Format.dateTime(since))").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = wallet.error {
                Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            }
            if let pusd = wallet.pusd {
                LabeledContent("PUSD", value: Format.pusd(pusd))
            }
            if let bch = wallet.bch {
                LabeledContent("BCH", value: String(format: "%.8f", bch))
            }
            ForEach(wallet.tokens, id: \.category) { t in
                LabeledContent(String(t.category.prefix(8)) + "…", value: t.amount.formatted())
            }
            if let coins = wallet.coins {
                LabeledContent("Coins", value: "\(coins)")
            }
            if let address = wallet.address {
                ExplorerLink(text: address)
            }
            if wallet.mode != .live {
                Text("Paper trading: this wallet is untouched until you press Go live on the desk.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .monospacedDigit()
    }
}
