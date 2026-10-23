import SwiftUI
import DeskKit

struct TradesView: View {
    enum Tab: String, CaseIterable { case ideas = "Ideas", trades = "Fills", open = "Open", closed = "Closed", liquidity = "Liquidity" }

    @Environment(DeskStore.self) private var store
    @State private var tab = Tab.trades

    var body: some View {
        List {
            Section {
                StatusBanner()
                Picker("Show", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            Section {
                switch tab {
                case .ideas:
                    if store.proposals.isEmpty { empty("No trade ideas yet.") }
                    ForEach(store.proposals) { p in NavigationLink(value: p) { ProposalRow(proposal: p) } }
                case .trades:
                    if store.trades.isEmpty { empty("No trades yet.") }
                    ForEach(store.trades) { t in NavigationLink(value: t) { TradeRow(trade: t) } }
                case .open:
                    if store.openPositions.isEmpty { empty("No open positions.") }
                    ForEach(store.openPositions) { p in NavigationLink(value: p) { PositionRow(position: p) } }
                case .closed:
                    if store.closedPositions.isEmpty { empty("No closed positions yet.") }
                    ForEach(store.closedPositions) { p in NavigationLink(value: p) { PositionRow(position: p) } }
                case .liquidity:
                    if store.liquidity.isEmpty { empty("No liquidity provided yet.") }
                    ForEach(store.openLiquidity + store.closedLiquidity) { p in NavigationLink(value: p) { LiquidityRow(position: p) } }
                }
            } footer: {
                if tab == .trades {
                    Text("* Price impact estimated from pool reserves, not a router quote.")
                } else if tab == .liquidity {
                    Text("Paper liquidity in Cauldron pools, open positions first. Fees are estimates.")
                }
            }
        }
        .navigationTitle("Trades")
        .navigationDestination(for: Proposal.self) { ProposalDetailView(proposal: $0) }
        .navigationDestination(for: Trade.self) { TradeDetailView(trade: $0) }
        .navigationDestination(for: Position.self) { PositionDetailView(position: $0) }
        .navigationDestination(for: LiquidityPosition.self) { LiquidityDetailView(position: $0) }
        .deskToolbar()
    }

    private func empty(_ text: String) -> some View {
        Text(text).foregroundStyle(.secondary)
    }
}

struct TradeDetailView: View {
    var trade: Trade

    var body: some View {
        List {
            Section {
                LabeledContent("Side", value: trade.side.uppercased())
                LabeledContent("Token", value: trade.symbol)
                LabeledContent("PUSD", value: Format.pusd(trade.pusd))
                LabeledContent("Price", value: Format.pusd(trade.pricePusd, decimals: 8) + " PUSD")
                if let amount = trade.amount {
                    LabeledContent("Amount (base units)", value: amount.formatted())
                }
                LabeledContent("Price impact", value: Format.pusd(trade.impactPct) + "%" + (trade.estimated ? " (estimated)" : ""))
                LabeledContent("Mode", value: trade.mode.rawValue)
                LabeledContent("Time", value: trade.ts.formatted(date: .abbreviated, time: .standard))
                if let cycle = trade.cycle { LabeledContent("Cycle", value: "\(cycle)") }
            }
            if let reason = trade.reason, !reason.isEmpty {
                Section("Reason") { Text(reason) }
            }
            Section("Token id") {
                Text(trade.tokenId).font(.system(.footnote, design: .monospaced))
            }
        }
        .navigationTitle("\(trade.side.capitalized) \(trade.symbol)")
    }
}

struct PositionDetailView: View {
    @Environment(DeskStore.self) private var store
    var position: Position

    var body: some View {
        List {
            Section {
                LabeledContent("Status", value: position.status)
                if let horizon = position.horizon { LabeledContent("Horizon", value: horizon) }
                if let signal = position.signal { LabeledContent("Signal", value: signal) }
                LabeledContent("Cost", value: Format.pusd(position.costPusd) + " PUSD")
                if let v = position.exitPusd ?? position.valuePusd {
                    LabeledContent(position.isOpen ? "Value now" : "Exit", value: Format.pusd(v) + " PUSD")
                }
                LabeledContent("P&L") {
                    Text("\(Format.signed(position.pnlPusd)) (\(Format.signedPct(position.displayPnlPct)))")
                        .foregroundStyle(Color.pnl(position.pnlPusd))
                }
                LabeledContent("Entry price", value: Format.pusd(position.entryPricePusd, decimals: 8))
                if let t = position.targetPct, let s = position.stopPct {
                    LabeledContent("Target / stop", value: "+\(Format.pusd(t, decimals: 0))% / -\(Format.pusd(s, decimals: 0))%")
                }
                if let opened = position.openedAt {
                    LabeledContent("Opened", value: opened.formatted(date: .abbreviated, time: .shortened))
                }
                if let closed = position.closedAt {
                    LabeledContent("Closed", value: closed.formatted(date: .abbreviated, time: .shortened))
                }
                if let reason = position.closeReason { LabeledContent("Close reason", value: reason) }
            }
            if let thesis = position.thesis, !thesis.isEmpty {
                Section("Thesis") { Text(thesis) }
            }
            if let review = store.review(of: position.id) {
                Section("Zara's review") { ReviewRow(review: review, showSymbol: false) }
            }
        }
        .navigationTitle(position.symbol)
    }
}

/// Colour for a proposal's status: green once filled or approved, red when risk or Nova said no.
func proposalColor(_ status: String) -> Color {
    switch status {
    case "filled", "approved", "risk_passed": .green
    case "risk_failed", "vetoed", "rejected": .red
    case "skipped": .secondary
    default: .orange
    }
}

struct ProposalRow: View {
    var proposal: Proposal

    var body: some View {
        HStack(spacing: 12) {
            AgentAvatar(id: proposal.agent, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(proposal.action.uppercased()) \(proposal.symbol)").font(.headline)
                Text([proposal.horizon, proposal.signal, Format.dateTime(proposal.ts)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(proposal.statusLabel)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(proposalColor(proposal.status).opacity(0.18)))
                .foregroundStyle(proposalColor(proposal.status))
        }
        .accessibilityElement(children: .combine)
    }
}

struct ProposalDetailView: View {
    var proposal: Proposal

    var body: some View {
        List {
            Section {
                LabeledContent("Status") {
                    Text(proposal.statusLabel).foregroundStyle(proposalColor(proposal.status))
                }
                LabeledContent("Proposed by", value: Team.displayName(proposal.agent))
                if let horizon = proposal.horizon { LabeledContent("Horizon", value: horizon) }
                if let signal = proposal.signal { LabeledContent("Signal", value: signal) }
                if let size = proposal.sizePct { LabeledContent("Size", value: Format.pusd(size, decimals: 1) + "% of book") }
                if let allowed = proposal.allowedPusd { LabeledContent("Allowed by risk", value: Format.pusd(allowed) + " PUSD") }
                if let t = proposal.targetPct, let s = proposal.stopPct {
                    LabeledContent("Target / stop", value: "+\(Format.pusd(t, decimals: 0))% / -\(Format.pusd(s, decimals: 0))%")
                }
                LabeledContent("Time", value: proposal.ts.formatted(date: .abbreviated, time: .shortened))
            }
            text("Thesis", proposal.thesis)
            text("Bull case", proposal.bullCase)
            text("Bear case", proposal.bearCase)
            text("Risk check", proposal.riskNotes)
            text("Decision", proposal.decisionNote)
        }
        .navigationTitle("\(proposal.action.capitalized) \(proposal.symbol)")
    }

    @ViewBuilder
    private func text(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            Section(title) { Text(value).tvFocusable() }
        }
    }
}
