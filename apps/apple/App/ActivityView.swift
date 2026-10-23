import SwiftUI
import DeskKit

struct ActivityView: View {
    @Environment(DeskStore.self) private var store
    @State private var agent: String?

    private var filtered: [DeskEvent] {
        guard let agent else { return store.events }
        return store.events.filter { $0.agent.lowercased() == agent }
    }

    var body: some View {
        List {
            Section {
                StatusBanner()
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        chip(nil, "All")
                        ForEach(Team.members) { chip($0.id, $0.name) }
                        chip("desk", "Desk")
                    }
                    .padding(.vertical, 4)
                }
            }
            Section {
                if filtered.isEmpty {
                    Text("Nothing yet. The team runs every 15 minutes.").foregroundStyle(.secondary)
                }
                ForEach(filtered) { e in
                    NavigationLink(value: e) { EventRow(event: e) }
                }
            }
        }
        .navigationTitle("Activity")
        .navigationDestination(for: DeskEvent.self) { EventDetailView(event: $0) }
        .deskToolbar()
    }

    private func chip(_ id: String?, _ title: String) -> some View {
        let on = agent == id
        return Button {
            agent = id
        } label: {
            Text(title)
                .font(.callout.weight(on ? .semibold : .regular))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Capsule().fill(on ? Color.agent(id ?? "").opacity(0.3) : Color.primary.opacity(0.06)))
        }
        .buttonStyle(.plain)
    }
}

struct EventDetailView: View {
    var event: DeskEvent

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    AgentAvatar(id: event.agent, size: 40)
                    VStack(alignment: .leading) {
                        Text(Team.displayName(event.agent)).font(.headline)
                        Label(event.kind, systemImage: EventStyle.symbol(event.kind))
                            .foregroundStyle(EventStyle.color(event.kind))
                    }
                }
                Text(event.message)
                LabeledContent("Time", value: event.ts.formatted(date: .abbreviated, time: .standard))
                if let cycle = event.cycle {
                    LabeledContent("Cycle", value: "\(cycle)")
                }
            }
            if let data = event.prettyData {
                Section("Data") {
                    Text(data).font(.system(.footnote, design: .monospaced))
                }
            }
        }
        .navigationTitle("Event \(event.id)")
    }
}
