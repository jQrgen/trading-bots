#if os(macOS)
import SwiftUI
import AppKit
import DeskKit

// Mac-only pieces: menu commands, the menu bar extra, and sortable tables with an inspector
// in place of the phone-style lists.

// MARK: - Commands

struct ScreenSelectionKey: FocusedValueKey {
    typealias Value = Binding<Screen?>
}

extension FocusedValues {
    var screenSelection: Binding<Screen?>? {
        get { self[ScreenSelectionKey.self] }
        set { self[ScreenSelectionKey.self] = newValue }
    }
}

struct DeskCommands: Commands {
    var store: DeskStore
    @FocusedBinding(\.screenSelection) private var selection

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button("Refresh") { Task { await store.refresh() } }
                .keyboardShortcut("r")
        }
        CommandMenu("Go") {
            ForEach(Array(Screen.navigable.enumerated()), id: \.element) { index, screen in
                Button(screen.title) { selection = screen }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
            }
        }
    }
}

// MARK: - Menu bar extra

/// Total value in the menu bar, so the desk is one click away without opening the window.
struct MenuBarLabel: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        Label(Format.pusd(store.state?.totalPusd) + " PUSD", systemImage: "chart.line.uptrend.xyaxis")
    }
}

struct MenuBarPanel: View {
    @Environment(DeskStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Trading Desk").font(.headline)
                Spacer()
                ModeBadge(mode: store.state?.mode ?? .paper, halted: store.state?.halted ?? false)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(Format.pusd(store.state?.totalPusd)).font(.system(size: 28, weight: .bold, design: .rounded)).monospacedDigit()
                Text("PUSD").foregroundStyle(.secondary)
            }
            HStack(spacing: 16) {
                stat("24h", Format.signed(store.change(overHours: 24)), Color.pnl(store.change(overHours: 24)))
                stat("Since start", Format.signed(store.state?.pnlAllPusd), Color.pnl(store.state?.pnlAllPusd))
                stat("Win rate", Format.ratio(store.state?.stats.winRate), .primary)
            }
            Divider()
            ForEach(store.events.prefix(5)) { e in
                HStack(alignment: .top, spacing: 8) {
                    AgentAvatar(id: e.agent, size: 18)
                    Text(e.message).font(.caption).lineLimit(2)
                }
            }
            if store.events.isEmpty {
                Text("No activity yet.").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            HStack {
                Button("Open Desk") {
                    openWindow(id: "desk")
                    NSApp.activate(ignoringOtherApps: true)
                }
                .keyboardShortcut(.defaultAction)
                Button("Refresh") { Task { await store.refresh() } }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
            RefreshFooter()
        }
        .padding(14)
        .frame(width: 340)
    }

    private func stat(_ title: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(tint)
        }
    }
}

// MARK: - Activity table

struct MacActivityView: View {
    @Environment(DeskStore.self) private var store
    @State private var agent = "all"
    @State private var search = ""
    @State private var selection: DeskEvent.ID?
    @State private var sortOrder = [KeyPathComparator(\DeskEvent.id, order: .reverse)]

    private var rows: [DeskEvent] {
        store.events
            .filter { agent == "all" || $0.agent.lowercased() == agent }
            .filter { search.isEmpty || $0.message.localizedCaseInsensitiveContains(search) || $0.kind.localizedCaseInsensitiveContains(search) }
            .sorted(using: sortOrder)
    }

    var body: some View {
        Table(rows, selection: $selection, sortOrder: $sortOrder) {
            TableColumn("Time", value: \.id) { e in
                Text(Format.dateTime(e.ts)).monospacedDigit().foregroundStyle(.secondary)
            }
            .width(min: 110, ideal: 120)
            TableColumn("Agent", value: \.agent) { e in
                HStack(spacing: 6) {
                    AgentAvatar(id: e.agent, size: 16)
                    Text(Team.displayName(e.agent))
                }
            }
            .width(min: 80, ideal: 90)
            TableColumn("Kind", value: \.kind) { e in
                Label(e.kind, systemImage: EventStyle.symbol(e.kind)).foregroundStyle(EventStyle.color(e.kind))
            }
            .width(min: 90, ideal: 110)
            TableColumn("Message", value: \.message) { e in
                Text(e.message).lineLimit(2).help(e.message)
            }
        }
        .searchable(text: $search, prompt: "Search messages")
        .toolbar {
            ToolbarItem {
                Picker("Agent", selection: $agent) {
                    Text("All agents").tag("all")
                    ForEach(store.team.members) { Text($0.name).tag($0.id) }
                    Text("Desk").tag("desk")
                }
                .pickerStyle(.menu)
            }
        }
        .inspector(isPresented: inspectorShown) {
            if let e = store.events.first(where: { $0.id == selection }) {
                EventDetailView(event: e).inspectorColumnWidth(min: 260, ideal: 320)
            }
        }
        .navigationTitle("Activity")
        .navigationSubtitle("\(rows.count) events")
        .deskToolbar()
    }

    private var inspectorShown: Binding<Bool> {
        Binding(get: { selection != nil }, set: { if !$0 { selection = nil } })
    }
}

// MARK: - Trades and positions tables

struct MacTradesView: View {
    enum Tab: String, CaseIterable { case ideas = "Ideas", fills = "Fills", open = "Open positions", closed = "Closed positions", liquidity = "Liquidity" }

    @Environment(DeskStore.self) private var store
    @State private var tab = Tab.fills
    @State private var search = ""
    @State private var tradeSelection: Trade.ID?
    @State private var positionSelection: Position.ID?
    @State private var proposalSelection: Proposal.ID?
    @State private var liquiditySelection: LiquidityPosition.ID?
    @State private var liquiditySort = [KeyPathComparator(\LiquidityPosition.openedAt, order: .reverse)]
    @State private var proposalSort = [KeyPathComparator(\Proposal.ts, order: .reverse)]
    @State private var tradeSort = [KeyPathComparator(\Trade.id, order: .reverse)]
    @State private var positionSort = [KeyPathComparator(\Position.id, order: .reverse)]

    var body: some View {
        Group {
            switch tab {
            case .ideas: proposalsTable
            case .fills: tradesTable
            case .open: positionsTable(store.openPositions)
            case .closed: positionsTable(store.closedPositions)
            case .liquidity: liquidityTable
            }
        }
        .searchable(text: $search, prompt: "Search tokens")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Show", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
        }
        .inspector(isPresented: inspectorShown) { inspector.inspectorColumnWidth(min: 280, ideal: 340) }
        .onChange(of: tab) { clearSelection() }
        .navigationTitle("Trades")
        .deskToolbar()
    }

    private func matches(_ symbol: String) -> Bool {
        search.isEmpty || symbol.localizedCaseInsensitiveContains(search)
    }

    private var proposalsTable: some View {
        Table(store.proposals.filter { matches($0.symbol) }.sorted(using: proposalSort), selection: $proposalSelection, sortOrder: $proposalSort) {
            TableColumn("Time", value: \.ts) { Text(Format.dateTime($0.ts)).monospacedDigit() }
                .width(min: 110, ideal: 120)
            TableColumn("Agent", value: \.agent) { p in
                HStack(spacing: 6) {
                    AgentAvatar(id: p.agent, size: 16)
                    Text(Team.displayName(p.agent))
                }
            }
            .width(min: 70, ideal: 80)
            TableColumn("Action", value: \.action) { Text($0.action.uppercased()) }
                .width(55)
            TableColumn("Token", value: \.symbol)
                .width(min: 60, ideal: 80)
            TableColumn("Horizon") { Text($0.horizon ?? "–") }
                .width(60)
            TableColumn("Signal") { Text($0.signal ?? "–") }
                .width(min: 80, ideal: 100)
            TableColumn("Status", value: \.status) { p in
                Text(p.statusLabel).fontWeight(.medium).foregroundStyle(proposalColor(p.status))
            }
            .width(min: 80, ideal: 90)
            TableColumn("Thesis") { Text($0.thesis ?? "").lineLimit(1).help($0.thesis ?? "") }
        }
    }

    private var tradesTable: some View {
        Table(store.trades.filter { matches($0.symbol) }.sorted(using: tradeSort), selection: $tradeSelection, sortOrder: $tradeSort) {
            TableColumn("Time", value: \.id) { Text(Format.dateTime($0.ts)).monospacedDigit() }
                .width(min: 110, ideal: 120)
            TableColumn("Side", value: \.side) { t in
                Text(t.side.uppercased()).fontWeight(.semibold).foregroundStyle(t.isBuy ? Color.up : Color.down)
            }
            .width(60)
            TableColumn("Token", value: \.symbol)
                .width(min: 60, ideal: 80)
            TableColumn("PUSD", value: \.pusd) { Text(Format.pusd($0.pusd)).monospacedDigit() }
                .width(min: 70, ideal: 90)
            TableColumn("Price (PUSD)") { Text(Format.pusd($0.pricePusd, decimals: 8)).monospacedDigit() }
                .width(min: 90, ideal: 110)
            TableColumn("Impact") { t in
                Text(t.impactPct.map { Format.pusd($0) + "%" + (t.estimated ? "*" : "") } ?? "–").monospacedDigit()
            }
            .width(60)
            TableColumn("Mode") { Text($0.mode.rawValue) }
                .width(50)
            TableColumn("Reason") { Text($0.reason ?? "").lineLimit(1).help($0.reason ?? "") }
        }
    }

    private func positionsTable(_ positions: [Position]) -> some View {
        Table(positions.filter { matches($0.symbol) }.sorted(using: positionSort), selection: $positionSelection, sortOrder: $positionSort) {
            TableColumn("Token", value: \.symbol)
                .width(min: 60, ideal: 80)
            TableColumn("Horizon") { Text($0.horizon ?? "–") }
                .width(60)
            TableColumn("Cost", value: \.costPusd) { Text(Format.pusd($0.costPusd)).monospacedDigit() }
                .width(min: 70, ideal: 90)
            TableColumn(tab == .closed ? "Exit" : "Value") { Text(Format.pusd($0.exitPusd ?? $0.valuePusd)).monospacedDigit() }
                .width(min: 70, ideal: 90)
            TableColumn("P&L", value: \.sortablePnl) { p in
                Text("\(Format.signed(p.pnlPusd)) (\(Format.signedPct(p.displayPnlPct)))")
                    .monospacedDigit()
                    .foregroundStyle(Color.pnl(p.pnlPusd))
            }
            .width(min: 110, ideal: 130)
            TableColumn("Target / stop") { p in
                Text(p.targetPct.map { "+\(Format.pusd($0, decimals: 0))%" } ?? "–") + Text(" / ") + Text(p.stopPct.map { "-\(Format.pusd($0, decimals: 0))%" } ?? "–")
            }
            .width(min: 90, ideal: 100)
            TableColumn("Opened", value: \.id) { Text($0.openedAt.map(Format.dateTime) ?? "–").monospacedDigit() }
                .width(min: 110, ideal: 120)
            TableColumn(tab == .closed ? "Close reason" : "Thesis") { p in
                let text = (tab == .closed ? p.closeReason : p.thesis) ?? ""
                Text(text).lineLimit(1).help(text)
            }
        }
    }

    private var liquidityTable: some View {
        Table(store.liquidity.filter { matches($0.symbol) }.sorted(using: liquiditySort), selection: $liquiditySelection, sortOrder: $liquiditySort) {
            TableColumn("Pool", value: \.symbol)
                .width(min: 60, ideal: 80)
            TableColumn("Status", value: \.status) { Text($0.status) }
                .width(55)
            TableColumn("Deposit", value: \.depositPusd) { Text(Format.pusd($0.depositPusd)).monospacedDigit() }
                .width(min: 70, ideal: 90)
            TableColumn("Fees (est.)", value: \.feesPusd) { Text(Format.pusd($0.feesPusd)).monospacedDigit() }
                .width(min: 70, ideal: 80)
            TableColumn("IL") { Text(Format.signedPct($0.ilPct)).monospacedDigit() }
                .width(60)
            TableColumn("P&L", value: \.sortablePnl) { p in
                Text("\(Format.signed(p.pnlPusd)) (\(Format.signedPct(p.pnlPct)))")
                    .monospacedDigit()
                    .foregroundStyle(Color.pnl(p.pnlPusd))
            }
            .width(min: 110, ideal: 130)
            TableColumn("Opened", value: \.openedAt) { Text(Format.dateTime($0.openedAt)).monospacedDigit() }
                .width(min: 110, ideal: 120)
            TableColumn("Thesis / close reason") { p in
                let text = (p.isOpen ? p.thesis : p.closeReason) ?? ""
                Text(text).lineLimit(1).help(text)
            }
        }
    }

    private func clearSelection() {
        tradeSelection = nil
        positionSelection = nil
        proposalSelection = nil
        liquiditySelection = nil
    }

    @ViewBuilder
    private var inspector: some View {
        if tab == .ideas, let p = store.proposals.first(where: { $0.id == proposalSelection }) {
            ProposalDetailView(proposal: p)
        } else if tab == .fills, let t = store.trades.first(where: { $0.id == tradeSelection }) {
            TradeDetailView(trade: t)
        } else if tab == .open || tab == .closed, let p = (store.openPositions + store.closedPositions).first(where: { $0.id == positionSelection }) {
            PositionDetailView(position: p)
        } else if tab == .liquidity, let p = store.liquidity.first(where: { $0.id == liquiditySelection }) {
            LiquidityDetailView(position: p)
        }
    }

    private var inspectorShown: Binding<Bool> {
        Binding(get: { hasSelection }, set: { if !$0 { clearSelection() } })
    }

    private var hasSelection: Bool {
        switch tab {
        case .ideas: return proposalSelection != nil
        case .fills: return tradeSelection != nil
        case .open, .closed: return positionSelection != nil
        case .liquidity: return liquiditySelection != nil
        }
    }
}

extension Position {
    /// P&L with unknown values sorted as zero, for table sorting.
    var sortablePnl: Double { pnlPusd ?? 0 }
}

extension LiquidityPosition {
    var sortablePnl: Double { pnlPusd ?? 0 }
}
#endif
