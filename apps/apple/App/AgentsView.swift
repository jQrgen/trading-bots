import SwiftUI
import DeskKit

struct AgentsView: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                StatusBanner()
                Text("The loop: " + Team.loop.map(Team.displayName).joined(separator: " → "))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                TeamGraphView()
                LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.cardMinWidth), spacing: Metrics.spacing)], spacing: Metrics.spacing) {
                    ForEach(store.agentCards) { card in
                        NavigationLink(value: card.member) {
                            AgentTile(card: card)
                        }
                        .tileButtonStyle()
                    }
                }
            }
            .padding(Metrics.padding)
        }
        .navigationTitle("Agents")
        .navigationDestination(for: TeamMember.self) { AgentDetailView(memberID: $0.id) }
        .deskToolbar()
    }
}

/// The reporting structure from graph/team.yaml, drawn as a tree.
struct TeamGraphView: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        Card(title: "Reporting structure") {
            VStack(spacing: 10) {
                node(label: "You", sub: "Owner", color: .gray)
                connector
                branch(for: "nova")
            }
            .frame(maxWidth: .infinity)
            Text("Kade can veto any trade, independently of Nova. Zara also reports to you directly.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func branch(for id: String) -> AnyView {
        guard let m = Team.member(id) else { return AnyView(EmptyView()) }
        let reports = Team.reports(of: id)
        return AnyView(VStack(spacing: 10) {
            node(label: m.name, sub: m.role + (m.hasVeto ? " · veto" : ""), color: .agent(m.id))
            if !reports.isEmpty {
                connector
                HStack(alignment: .top, spacing: 12) {
                    ForEach(reports) { branch(for: $0.id) }
                }
            }
        })
    }

    private var connector: some View {
        Rectangle().fill(.secondary.opacity(0.4)).frame(width: 2, height: 14)
    }

    private func node(label: String, sub: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.subheadline.weight(.semibold))
            Text(sub).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minWidth: 64)
        .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.18)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(0.6)))
    }
}

struct AgentDetailView: View {
    @Environment(DeskStore.self) private var store
    var memberID: String

    var body: some View {
        let card = store.agentCards.first { $0.id == memberID }
        let events = store.events.filter { $0.agent.lowercased() == memberID }
        List {
            if let card {
                Section {
                    HStack(spacing: 14) {
                        AgentAvatar(id: card.id, size: 52)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(card.member.role) · \(card.member.horizon) horizon").font(.headline)
                            Text(card.member.job).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Status", value: card.status ?? "Waiting for first cycle")
                    LabeledContent("Updated", value: Format.relative(card.updatedAt))
                    LabeledContent("Reports to", value: card.member.reportsTo.map { $0 == Team.owner ? "You" : Team.displayName($0) }.joined(separator: ", "))
                }
            }
            Section("Recent activity") {
                if events.isEmpty {
                    Text("No activity in the loaded log.").foregroundStyle(.secondary)
                }
                ForEach(events.prefix(100)) { e in
                    NavigationLink(value: e) { EventRow(event: e) }
                }
            }
        }
        .navigationTitle(Team.displayName(memberID))
        .navigationDestination(for: DeskEvent.self) { EventDetailView(event: $0) }
    }
}
