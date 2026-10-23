import SwiftUI
import DeskKit

struct AgentsView: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                StatusBanner()
                Text("Cauldron Trader runs every role in order, every 15 minutes: " + store.team.loop.map(store.team.displayName).joined(separator: " → "))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                TeamGraphView()
                LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.agentTileMinWidth), spacing: Metrics.spacing, alignment: .top)], alignment: .leading, spacing: Metrics.spacing) {
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

/// The reporting structure stored in the database (/api/team), drawn as a tree.
struct TeamGraphView: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        Card(title: "Reporting structure") {
            VStack(spacing: 10) {
                node(label: "You", sub: "Owner", color: .gray)
                connector
                ForEach(store.team.reports(of: store.team.owner)) { branch(for: $0.id) }
            }
            .frame(maxWidth: .infinity)
            let vetoes = store.team.members.filter(\.hasVeto).map(\.name)
            if !vetoes.isEmpty {
                Text("\(vetoes.joined(separator: ", ")) can veto any trade.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func branch(for id: String) -> AnyView {
        guard let m = store.team.member(id) else { return AnyView(EmptyView()) }
        let reports = store.team.reports(of: id)
        return AnyView(VStack(spacing: 10) {
            node(label: m.name, sub: m.role + (m.hasVeto ? " · veto" : ""), color: .agent(m.id), running: running(m.id))
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

    private func running(_ id: String) -> Bool {
        store.state?.cycleRunning == true && store.state?.activeRole?.lowercased() == id
    }

    private func node(label: String, sub: String, color: Color, running: Bool = false) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.subheadline.weight(.semibold))
            Text(sub).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if running {
                Text("Running").font(.caption2.weight(.bold)).foregroundStyle(Color.up)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minWidth: 64)
        .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(running ? 0.32 : 0.18)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(running ? 1 : 0.6), lineWidth: running ? 2 : 1))
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
                            Text(card.member.role).font(.headline)
                            Text("\(card.member.horizonLabel) horizon" + (card.member.hasVeto ? " · can veto" : ""))
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Status", value: card.displayStatus)
                    LabeledContent("Updated", value: Format.relative(card.updatedAt))
                    LabeledContent("Reports to", value: card.member.reportsTo.map(store.team.displayName).joined(separator: ", "))
                    if !card.member.tools.isEmpty {
                        LabeledContent("Tools", value: card.member.tools.joined(separator: ", "))
                    }
                }
                Section {
                    if let role = store.roleDocument(for: memberID) {
                        NavigationLink(value: role) {
                            Label("Role and instructions (v\(role.version))", systemImage: "doc.text")
                        }
                    }
                    NavigationLink(value: AgentCallsRoute(agent: memberID)) {
                        Label("Grok calls: prompts and replies", systemImage: "brain")
                    }
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
        .navigationTitle(store.team.displayName(memberID))
        .navigationDestination(for: DeskEvent.self) { EventDetailView(event: $0) }
        .navigationDestination(for: KnowledgeEntry.self) { KnowledgeDetailView(entry: $0) }
        .navigationDestination(for: AgentCallsRoute.self) { AgentCallsView(agent: $0.agent) }
    }
}

struct AgentCallsRoute: Hashable {
    var agent: String
}

/// The exact Grok prompts and replies for one agent, newest first (GET /api/agent-calls).
struct AgentCallsView: View {
    @Environment(DeskStore.self) private var store
    var agent: String
    @State private var calls: [AgentCall] = []
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.secondary)
            } else if loaded && calls.isEmpty {
                Text("No calls recorded. The team thinks in the Grok app, so its prompts and replies aren't stored here; they show up only when the desk calls Grok itself.")
                    .foregroundStyle(.secondary)
            }
            ForEach(calls) { call in
                NavigationLink(value: call) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(Format.dateTime(call.ts)).font(.headline).monospacedDigit()
                            Spacer()
                            if call.error != nil {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            }
                            if call.search {
                                Image(systemName: "globe").foregroundStyle(.secondary)
                            }
                            if let ms = call.ms {
                                Text("\(Format.pusd(Double(ms) / 1000, decimals: 1)) s").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Text(call.output ?? call.error ?? "").font(.callout).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
        .navigationTitle("\(store.team.displayName(agent)): Grok calls")
        .navigationDestination(for: AgentCall.self) { AgentCallDetailView(call: $0) }
        .task {
            do {
                calls = try await store.service.agentCalls(agent: agent, limit: 100)
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            loaded = true
        }
    }
}

struct AgentCallDetailView: View {
    @Environment(DeskStore.self) private var store
    var call: AgentCall
    @State private var full: AgentCall?

    var body: some View {
        let c = full ?? call
        List {
            Section {
                LabeledContent("Time", value: c.ts.formatted(date: .abbreviated, time: .standard))
                LabeledContent("Model", value: c.model + (c.search ? " with live search" : ""))
                if let ms = c.ms { LabeledContent("Took", value: "\(Format.pusd(Double(ms) / 1000, decimals: 1)) s") }
                if let cycle = c.cycle { LabeledContent("Cycle", value: "\(cycle)") }
            }
            if let error = c.error {
                Section("Error") { Text(error).foregroundStyle(.red) }
            }
            Section("Reply") { mono(c.output ?? "–") }
            Section("Input") { mono(c.input) }
            Section("System prompt") {
                if let prompt = c.systemPrompt {
                    mono(prompt)
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Call \(c.id)")
        .task { full = try? await store.service.agentCall(id: call.id) }
    }

    private func mono(_ text: String) -> some View {
        Text(text).font(.system(.footnote, design: .monospaced)).tvFocusable()
    }
}
