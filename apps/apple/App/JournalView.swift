import SwiftUI
import DeskKit

struct JournalView: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        List {
            Section {
                StatusBanner()
            }
            Section("Daily reports") {
                if store.journal.isEmpty {
                    Text("Zara writes the first journal entry tonight.").foregroundStyle(.secondary)
                }
                ForEach(store.journal) { entry in
                    NavigationLink(value: entry) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.ts.formatted(date: .complete, time: .omitted)).font(.headline)
                            Text(entry.text).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                        }
                    }
                }
            }
            Section {
                ForEach(store.lessons) { lesson in
                    Label {
                        Text(lesson.lesson)
                            .strikethrough(!lesson.isActive)
                            .foregroundStyle(lesson.isActive ? .primary : .secondary)
                    } icon: {
                        Image(systemName: lesson.isActive ? "lightbulb.fill" : "xmark.circle")
                            .foregroundStyle(lesson.isActive ? Color.yellow : Color.secondary)
                    }
                    .tvFocusable()
                }
            } header: {
                Text("Lessons")
            } footer: {
                Text("Active lessons feed the agents' prompts. Rejected ones are kept for the record.")
            }
        }
        .navigationTitle("Journal")
        .navigationDestination(for: JournalEntry.self) { JournalEntryView(entry: $0) }
        .deskToolbar()
    }
}

struct JournalEntryView: View {
    var entry: JournalEntry

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                Text(entry.text).tvFocusable()
                if !entry.lessons.isEmpty {
                    Card(title: "Lessons from this day") {
                        ForEach(entry.lessons, id: \.self) { Label($0, systemImage: "lightbulb") }
                    }
                }
            }
            .padding(Metrics.padding)
            .frame(maxWidth: 760, alignment: .leading)
        }
        .navigationTitle(entry.ts.formatted(date: .abbreviated, time: .omitted))
    }
}
