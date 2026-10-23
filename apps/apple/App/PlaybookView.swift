import SwiftUI
import Charts
import DeskKit

/// Everything the team knows and has learned, all read from the database: the scorecard,
/// strategy, risk limits and market notes, Zara's daily reports and the lessons.
struct PlaybookView: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        List {
            Section {
                StatusBanner()
            }
            if store.scorecardHistory.count >= 2 {
                Section {
                    PnlHistoryChart(cards: store.scorecardHistory)
                        .frame(height: Metrics.chartHeight)
                        .tvFocusable()
                } header: {
                    Text("Realised P&L over time")
                } footer: {
                    Text("The scorecard's rolling P&L at each cycle over the last 90 days.")
                }
            }
            if let card = store.scorecard {
                ScorecardSection(card: card)
            }
            Section {
                if store.playbook.isEmpty {
                    Text("Loads from the desk's database.").foregroundStyle(.secondary)
                }
                ForEach(store.playbook) { entry in
                    NavigationLink(value: entry) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.title).font(.headline)
                            Text("v\(entry.version) · \(updatedBy(entry.updatedBy)) · \(Format.relative(entry.updatedAt))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Playbook")
            } footer: {
                Text("Strategy, risk limits and notes the agents read every cycle. Every change is versioned.")
            }
            Section {
                if store.files.isEmpty {
                    Text("The agents haven't written any shared notes yet.").foregroundStyle(.secondary)
                }
                ForEach(store.files) { file in
                    NavigationLink(value: file) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(file.path).font(.headline)
                            Text("v\(file.version) · \(file.updatedBy.map { store.team.displayName($0) } ?? "–") · \(Format.relative(file.updatedAt))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Shared notes")
            } footer: {
                Text("Files the agents keep for each other in the database, such as watchlists and handovers.")
            }
            if !store.reviews.isEmpty {
                Section {
                    ForEach(store.reviews.prefix(20)) { ReviewRow(review: $0) }
                } header: {
                    Text("Trade reviews")
                } footer: {
                    Text("Zara grades each closed trade's process separately from its result. R is the result in multiples of the planned risk.")
                }
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
        .navigationTitle("Playbook")
        .navigationDestination(for: KnowledgeEntry.self) { KnowledgeDetailView(entry: $0) }
        .navigationDestination(for: JournalEntry.self) { JournalEntryView(entry: $0) }
        .navigationDestination(for: BotFile.self) { BotFileView(file: $0) }
        .deskToolbar()
    }

    private func updatedBy(_ who: String) -> String {
        switch who {
        case "owner": "edited by you"
        case "seed": "starter version"
        default: "edited by \(store.team.displayName(who))"
        }
    }
}

struct PnlHistoryChart: View {
    var cards: [Scorecard]

    var body: some View {
        let points = cards.compactMap { c in c.ts.map { (ts: $0, pnl: c.overall.pnlPusd) } }
        let color: Color = (points.last?.pnl ?? 0) < 0 ? .down : .up
        Chart {
            ForEach(Array(points.enumerated()), id: \.offset) { _, p in
                LineMark(x: .value("Time", p.ts), y: .value("PUSD", p.pnl))
                    .foregroundStyle(color)
                    .interpolationMethod(.monotone)
            }
            RuleMark(y: .value("Zero", 0))
                .foregroundStyle(.secondary)
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
        }
    }
}

struct ScorecardSection: View {
    var card: Scorecard

    var body: some View {
        Section {
            bucketRow("Overall", card.overall)
            ForEach(card.byHorizon.keys.sorted(), id: \.self) { key in
                bucketRow(key.capitalized + " horizon", card.byHorizon[key]!)
            }
            ForEach(card.bySignal.keys.sorted(), id: \.self) { key in
                bucketRow("Signal: " + key, card.bySignal[key]!)
            }
            ForEach(Array(card.holdingTimes.enumerated()), id: \.offset) { _, row in
                bucketRow("Held " + row.label, row.bucket)
            }
        } header: {
            Text("Scorecard" + (card.windowDays.map { ", last \($0) days" } ?? ""))
        } footer: {
            Text("Losing horizons get smaller bets automatically until they recover.")
        }
    }

    private func bucketRow(_ title: String, _ b: Scorecard.Bucket) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                Text("\(b.trades) trades · win rate \(Format.ratio(b.winRate)) · avg \(Format.signedPct(b.avgPnlPct))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(Format.signed(b.pnlPusd) + " PUSD").monospacedDigit().foregroundStyle(Color.pnl(b.pnlPusd))
        }
        .tvFocusable()
    }
}

struct KnowledgeDetailView: View {
    var entry: KnowledgeEntry

    var body: some View {
        List {
            Section {
                if entry.isJSON {
                    let rows = JSONRows.rows(entry.body)
                    if rows.isEmpty {
                        Text(entry.body).font(.system(.footnote, design: .monospaced))
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        LabeledContent(row.label, value: row.value)
                    }
                } else {
                    MarkdownView(text: entry.body)
                }
            } footer: {
                Text("Version \(entry.version), updated \(entry.updatedAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "–") by \(entry.updatedBy).")
            }
            Section {
                NavigationLink(value: KnowledgeHistoryRoute(entry: entry)) {
                    Label("Version history", systemImage: "clock.arrow.circlepath")
                }
            }
        }
        .navigationTitle(entry.title)
        .navigationDestination(for: KnowledgeHistoryRoute.self) { KnowledgeHistoryView(entry: $0.entry) }
    }
}

struct KnowledgeHistoryRoute: Hashable {
    var entry: KnowledgeEntry
}

struct KnowledgeHistoryView: View {
    @Environment(DeskStore.self) private var store
    var entry: KnowledgeEntry
    @State private var versions: [KnowledgeVersion] = []
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.secondary)
            }
            ForEach(versions) { v in
                NavigationLink(value: v) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Version \(v.version)").font(.headline)
                        Text("\(v.updatedBy) · \(v.updatedAt.map(Format.dateTime) ?? "–")").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("\(entry.title) history")
        .navigationDestination(for: KnowledgeVersion.self) { v in
            KnowledgeVersionView(title: "\(entry.title) v\(v.version)", text: v.body, isJSON: entry.isJSON)
        }
        .task {
            do {
                versions = try await store.service.knowledgeHistory(key: entry.key)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// A past version's text, shown as-is (JSON pretty-printed).
struct KnowledgeVersionView: View {
    var title: String
    var text: String
    var isJSON: Bool

    var body: some View {
        List {
            if isJSON {
                Text(text).font(.system(.footnote, design: .monospaced)).tvFocusable()
            } else {
                MarkdownView(text: text)
            }
        }
        .navigationTitle(title)
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

/// Renders the markdown the bots and owner write: headings, bullet lists and inline styling.
struct MarkdownView: View {
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                block.view
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tvFocusable()
    }

    private struct Block {
        var kind: Kind
        var text: String
        enum Kind { case h1, h2, h3, bullet, paragraph, code }

        @ViewBuilder var view: some View {
            switch kind {
            case .h1: Text(inline(text)).font(.title2.weight(.bold)).padding(.top, 4)
            case .h2: Text(inline(text)).font(.title3.weight(.semibold)).padding(.top, 4)
            case .h3: Text(inline(text)).font(.headline)
            case .bullet:
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("•")
                    Text(inline(text))
                }
            case .paragraph: Text(inline(text))
            case .code: Text(text).font(.system(.footnote, design: .monospaced))
            }
        }

        private func inline(_ s: String) -> AttributedString {
            (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
        }
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { out.append(Block(kind: .paragraph, text: paragraph.joined(separator: " "))); paragraph = [] }
        }
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let lines = code {
                    out.append(Block(kind: .code, text: lines.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
                continue
            }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty { flush(); continue }
            if line.hasPrefix("### ") { flush(); out.append(Block(kind: .h3, text: String(line.dropFirst(4)))) }
            else if line.hasPrefix("## ") { flush(); out.append(Block(kind: .h2, text: String(line.dropFirst(3)))) }
            else if line.hasPrefix("# ") { flush(); out.append(Block(kind: .h1, text: String(line.dropFirst(2)))) }
            else if line.hasPrefix("- ") || line.hasPrefix("* ") { flush(); out.append(Block(kind: .bullet, text: String(line.dropFirst(2)))) }
            else { paragraph.append(line) }
        }
        if let lines = code { out.append(Block(kind: .code, text: lines.joined(separator: "\n"))) }
        flush()
        return out
    }
}
