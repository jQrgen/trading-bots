import SwiftUI
import Charts
import DeskKit

struct OverviewView: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                StatusBanner()
                header
                tiles
                BalanceChart()
                LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.cardMinWidth), spacing: Metrics.spacing, alignment: .top)],
                          spacing: Metrics.spacing) {
                    holdings
                    if let wallet = store.wallet, wallet.hasSecret {
                        WalletCard(wallet: wallet)
                    }
                    openPositions
                }
                agents
                recentActivity
            }
            .padding(Metrics.padding)
        }
        .navigationTitle("Trading Desk")
        .deskToolbar()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                ModeBadge(mode: store.state?.mode ?? .paper, halted: store.state?.halted ?? false, frozen: store.state?.frozen ?? false)
                Spacer()
                RefreshFooter().fixedSize()
            }
            Text("Total value").font(.subheadline).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Format.pusd(store.state?.totalPusd))
                    .font(Metrics.heroFont)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text("PUSD").font(.title3.weight(.semibold)).foregroundStyle(.secondary)
            }
            if let pnl = store.state?.pnlAllPusd {
                Text("\(Format.signed(pnl)) PUSD (\(Format.signedPct(store.state?.pnlAllPct))) since \(store.isLive ? "going live" : "start")")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Color.pnl(pnl))
            }
            if let total = store.state?.totalDepositedPusd, store.isLive {
                Text("\(Format.pusd(total)) PUSD deposited in total, not counted as profit")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let deposits = store.state?.depositsPusd, deposits != 0 {
                Text(deposits > 0 ? "\(Format.pusd(deposits)) PUSD deposited, not counted as profit" : "\(Format.pusd(-deposits)) PUSD withdrawn, not counted as loss")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .tvFocusable()
    }

    private var tiles: some View {
        let stats = store.state?.stats
        let day = store.dayChange
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.tileMinWidth), spacing: Metrics.spacing)], spacing: Metrics.spacing) {
            StatTile(title: "24h", value: Format.signed(day), detail: "PUSD", tint: Color.pnl(day))
            StatTile(title: "Realised", value: Format.signed(stats?.realizedPusd), detail: "PUSD", tint: Color.pnl(stats?.realizedPusd))
            StatTile(title: "Win rate", value: Format.ratio(stats?.winRate),
                     detail: stats.map { "\($0.wins) of \($0.closed) closed" })
            StatTile(title: "Open", value: "\(store.openPositions.count)", detail: "positions")
            StatTile(title: "BCH", value: Format.pusd(store.state?.bchPusd), detail: "PUSD per BCH")
        }
    }

    private var holdings: some View {
        Card(title: "Holdings") {
            let rows = (store.state?.holdings ?? []).sorted { ($0.valuePusd ?? 0) > ($1.valuePusd ?? 0) }
            if rows.isEmpty {
                Text("The wallet opens on the first cycle.").foregroundStyle(.secondary)
            } else {
                let total = rows.compactMap(\.valuePusd).reduce(0, +)
                ForEach(rows) { h in
                    HStack {
                        Text(h.symbol).font(.body.weight(.medium))
                        Spacer()
                        if total > 0, let v = h.valuePusd {
                            Text(Format.ratio(v / total)).foregroundStyle(.secondary).monospacedDigit()
                        }
                        Text(Format.pusd(h.valuePusd)).monospacedDigit().frame(minWidth: 90, alignment: .trailing)
                    }
                }
            }
        }
    }

    private var openPositions: some View {
        Card(title: "Open positions") {
            if store.openPositions.isEmpty {
                Text("No open positions.").foregroundStyle(.secondary)
            } else {
                ForEach(store.openPositions) { PositionRow(position: $0) }
            }
        }
    }

    private var agents: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Agents").font(.headline).foregroundStyle(.secondary)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.tileMinWidth * 1.4), spacing: Metrics.spacing)], spacing: Metrics.spacing) {
                ForEach(store.agentCards) { card in
                    NavigationLink(value: card.member) {
                        AgentTile(card: card)
                    }
                    .tileButtonStyle()
                }
            }
        }
        .navigationDestination(for: TeamMember.self) { AgentDetailView(memberID: $0.id) }
    }

    private var recentActivity: some View {
        Card(title: "Latest activity") {
            if store.events.isEmpty {
                Text("Nothing yet. The team runs every 15 minutes.").foregroundStyle(.secondary)
            } else {
                ForEach(store.events.prefix(8)) { EventRow(event: $0) }
            }
        }
    }
}

struct AgentTile: View {
    var card: AgentCard

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AgentAvatar(id: card.id, size: 36)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(card.member.name).font(.headline)
                    Spacer()
                    if let at = card.updatedAt {
                        Text(Format.relative(at)).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Text(card.member.role).font(.caption).foregroundStyle(.secondary)
                Text(card.displayStatus)
                    .font(.callout)
                    .lineLimit(4)
                    .foregroundStyle(card.status == nil && card.lastEvent == nil ? .secondary : .primary)
            }
        }
        .padding(Metrics.padding * 0.75)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.agent(card.id).opacity(0.12)))
        .contentShape(Rectangle())
    }
}

struct BalanceChart: View {
    @Environment(DeskStore.self) private var store
    private let ranges = [(1, "24h"), (7, "7d"), (30, "30d"), (90, "90d")]

    var body: some View {
        Card {
            HStack {
                Text("Balance").font(.headline).foregroundStyle(.secondary)
                Spacer()
                if let change = store.chartChange {
                    Text(Format.signed(change) + " PUSD").font(.callout.weight(.medium)).foregroundStyle(Color.pnl(change))
                }
            }
            Picker("Range", selection: Binding(get: { store.chartDays }, set: { days in Task { await store.setChartDays(days) } })) {
                ForEach(ranges, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if store.snapshots.count < 2 {
                Text("The chart fills in after a couple of cycles.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: Metrics.chartHeight)
            } else {
                chart.frame(height: Metrics.chartHeight)
            }
        }
    }

    private var chart: some View {
        let values = store.snapshots.map(\.totalPusd)
        let lo = values.min() ?? 0, hi = values.max() ?? 1
        let pad = max((hi - lo) * 0.1, 0.5)
        let floor = lo - pad
        let color: Color = (store.chartChange ?? 0) < 0 ? .down : .up
        return Chart {
            ForEach(store.snapshots) { s in
                AreaMark(x: .value("Time", s.ts), yStart: .value("Floor", floor), yEnd: .value("PUSD", s.totalPusd))
                    .foregroundStyle(LinearGradient(colors: [color.opacity(0.3), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Time", s.ts), y: .value("PUSD", s.totalPusd))
                    .foregroundStyle(color)
                    .interpolationMethod(.monotone)
            }
            if let start = store.state?.startPusd, start >= floor, start <= hi + pad {
                RuleMark(y: .value("Start", start))
                    .foregroundStyle(.secondary)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("start").font(.caption2).foregroundStyle(.secondary)
                    }
            }
        }
        .chartYScale(domain: floor...(hi + pad))
        .accessibilityLabel("Portfolio value in PUSD")
    }
}
