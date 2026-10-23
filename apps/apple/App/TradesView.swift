import SwiftUI
import DeskKit

struct TradesView: View {
    enum Tab: String, CaseIterable { case trades = "Fills", open = "Open", closed = "Closed" }

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
                case .trades:
                    if store.trades.isEmpty { empty("No trades yet.") }
                    ForEach(store.trades) { t in NavigationLink(value: t) { TradeRow(trade: t) } }
                case .open:
                    if store.openPositions.isEmpty { empty("No open positions.") }
                    ForEach(store.openPositions) { p in NavigationLink(value: p) { PositionRow(position: p) } }
                case .closed:
                    if store.closedPositions.isEmpty { empty("No closed positions yet.") }
                    ForEach(store.closedPositions) { p in NavigationLink(value: p) { PositionRow(position: p) } }
                }
            } footer: {
                if tab == .trades {
                    Text("* Price impact estimated from pool reserves, not a router quote.")
                }
            }
        }
        .navigationTitle("Trades")
        .navigationDestination(for: Trade.self) { TradeDetailView(trade: $0) }
        .navigationDestination(for: Position.self) { PositionDetailView(position: $0) }
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
        }
        .navigationTitle(position.symbol)
    }
}
