import SwiftUI
import Charts
import DeskKit

/// What the team finds before it trades: the mood on X, new tokens on Cauldron and the launchpad,
/// and Vela's research notes, all read from the database.
struct ResearchView: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        List {
            Section {
                StatusBanner()
            }
            Section {
                if store.marketMood.isEmpty {
                    Text("No readings yet.").foregroundStyle(.secondary)
                }
                ForEach(store.marketMood) { SentimentRow(reading: $0) }
            } header: {
                Text("Mood on X")
            } footer: {
                Text("Grok reads posts about BCH and Cauldron every cycle and scores them from -1 to +1.")
            }
            Section {
                if store.markets.isEmpty {
                    Text("No market data yet.").foregroundStyle(.secondary)
                }
                ForEach(store.markets.prefix(25)) { tick in
                    NavigationLink(value: tick) { MarketRow(tick: tick) }
                }
            } header: {
                Text("Markets")
            } footer: {
                Text("The latest scan of each Cauldron pool, largest first. Open one for its price chart.")
            }
            Section {
                NavigationLink(value: BriefingRoute()) {
                    Label("Latest Grok Bot briefing", systemImage: "doc.text.magnifyingglass")
                }
            }
            Section {
                if store.tokens.isEmpty {
                    Text("The scanners haven't logged any tokens yet.").foregroundStyle(.secondary)
                }
                ForEach(store.tokens) { token in
                    NavigationLink(value: token) { TokenRow(token: token) }
                }
            } header: {
                Text("New tokens")
            } footer: {
                Text("Every token seen on Cauldron or the launchpad, and how far research got.")
            }
            Section("Latest research") {
                if store.research.isEmpty {
                    Text("No research notes yet.").foregroundStyle(.secondary)
                }
                ForEach(store.research.prefix(30)) { note in
                    NavigationLink(value: note) { ResearchNoteRow(note: note) }
                }
            }
            Section {
                if store.launchpad.isEmpty {
                    Text("No launchpad sales yet.").foregroundStyle(.secondary)
                }
                ForEach(store.launchpad) { LaunchpadRow(sale: $0) }
            } header: {
                Text("Launchpad")
            }
        }
        .navigationTitle("Research")
        .navigationDestination(for: TokenSeen.self) { TokenDetailView(token: $0) }
        .navigationDestination(for: ResearchNote.self) { ResearchNoteView(note: $0) }
        .navigationDestination(for: MarketTick.self) { MarketDetailView(tick: $0) }
        .navigationDestination(for: BriefingRoute.self) { _ in BriefingView() }
        .deskToolbar()
    }
}

enum Verdict {
    static func color(_ verdict: String) -> Color {
        switch verdict {
        case "opportunity", "traded": .up
        case "watch", "researched": .orange
        case "avoid": .down
        default: .secondary
        }
    }
}

/// A small coloured capsule for a verdict or research status.
struct VerdictBadge: View {
    var text: String

    var body: some View {
        Text(text.capitalized)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Verdict.color(text).opacity(0.18), in: Capsule())
            .foregroundStyle(Verdict.color(text))
    }
}

struct SentimentRow: View {
    var reading: SentimentReading

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(reading.title).font(.headline)
                Spacer()
                Text("\(reading.moodLabel) \(Format.signed(reading.score))")
                    .monospacedDigit()
                    .foregroundStyle(Color.pnl(reading.score))
            }
            MoodBar(score: reading.score)
            Text(reading.summary).font(.callout).foregroundStyle(.secondary)
            Text(caption).font(.caption).foregroundStyle(.tertiary)
            SourceLinks(urls: reading.sources)
        }
        .padding(.vertical, 2)
        .tvFocusable()
    }

    private var caption: String {
        let fields: [String?] = [reading.mentions.map { "\($0) posts" }, Format.relative(reading.ts)]
        return fields.compactMap { $0 }.joined(separator: " · ")
    }
}

/// A -1…+1 scale with a marker at the score (Gauge isn't available on Apple TV).
struct MoodBar: View {
    var score: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(LinearGradient(colors: [.down, .secondary.opacity(0.4), .up], startPoint: .leading, endPoint: .trailing))
                    .frame(height: 6)
                Circle()
                    .fill(Color.pnl(score))
                    .overlay(Circle().stroke(.background, lineWidth: 2))
                    .frame(width: 14, height: 14)
                    .offset(x: (geo.size.width - 14) * (score + 1) / 2)
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: 14)
        .accessibilityLabel("Score \(Format.signed(score)) from -1 to +1")
    }
}

struct TokenRow: View {
    var token: TokenSeen

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(token.symbol).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VerdictBadge(text: token.researchStatus)
        }
    }

    private var detail: String {
        let fields: [String?] = [token.name, token.source.capitalized, "seen " + Format.relative(token.firstSeen)]
        var parts = fields.compactMap { $0 }
        if let tvl = token.lastTvlBch { parts.append(String(format: "%.1f BCH TVL", tvl)) }
        return parts.joined(separator: " · ")
    }
}

struct ResearchNoteRow: View {
    var note: ResearchNote

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(note.symbol).font(.headline)
                VerdictBadge(text: note.verdict)
                Spacer()
                Text(Format.relative(note.ts)).font(.caption).foregroundStyle(.secondary)
            }
            Text(note.opportunity ?? note.note).font(.callout).foregroundStyle(.secondary).lineLimit(3)
        }
    }
}

struct LaunchpadRow: View {
    var sale: LaunchpadSale

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(sale.offeredTokenId ?? sale.id).font(.headline).lineLimit(1)
                Spacer()
                if let status = sale.status { VerdictBadge(text: status) }
            }
            ForEach(Array(JSONRows.rows(sale.data).enumerated()), id: \.offset) { _, row in
                LabeledContent(row.label, value: row.value).font(.caption)
            }
            Text("First seen \(Format.relative(sale.firstSeen))").font(.caption).foregroundStyle(.tertiary)
        }
        .tvFocusable()
    }
}

struct TokenDetailView: View {
    @Environment(DeskStore.self) private var store
    var token: TokenSeen

    var body: some View {
        List {
            Section {
                LabeledContent("Status") { VerdictBadge(text: token.researchStatus) }
                if let name = token.name { LabeledContent("Name", value: name) }
                LabeledContent("Found on", value: token.source.capitalized)
                LabeledContent("First seen", value: Format.dateTime(token.firstSeen))
                if let pool = token.firstPoolTs { LabeledContent("First pool", value: Format.dateTime(pool)) }
                if let tvl = token.lastTvlBch { LabeledContent("Pool TVL", value: String(format: "%.2f BCH", tvl)) }
                if let last = token.lastResearchAt { LabeledContent("Last researched", value: Format.relative(last)) }
                LabeledContent("Token ID") {
                    Text(token.tokenId).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        #if !os(tvOS)
                        .textSelection(.enabled)
                        #endif
                }
            }
            .tvFocusable()
            let moods = store.mood(about: token.tokenId)
            if !moods.isEmpty {
                Section("Mood on X") {
                    ForEach(moods) { SentimentRow(reading: $0) }
                }
            }
            Section("Research") {
                let notes = store.notes(about: token.tokenId)
                if notes.isEmpty {
                    Text("Not researched yet.").foregroundStyle(.secondary)
                }
                ForEach(notes) { note in
                    NavigationLink(value: note) { ResearchNoteRow(note: note) }
                }
            }
        }
        .navigationTitle(token.symbol)
    }
}

struct ResearchNoteView: View {
    @Environment(DeskStore.self) private var store
    var note: ResearchNote

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                HStack {
                    VerdictBadge(text: note.verdict)
                    Text("\(store.team.displayName(note.agent)) · \(Format.dateTime(note.ts))\(note.cycle.map { " · cycle \($0)" } ?? "")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let opportunity = note.opportunity {
                    Card(title: "How it could make money") { Text(opportunity) }
                }
                Card(title: "Findings") { Text(note.note) }
                if !note.sources.isEmpty {
                    Card(title: "Sources") { SourceLinks(urls: note.sources) }
                }
            }
            .padding(Metrics.padding)
            .frame(maxWidth: 760, alignment: .leading)
        }
        .navigationTitle("\(note.symbol) research")
    }
}

/// Links Grok used. Apple TV can't open web pages, so it shows the hosts as text.
struct SourceLinks: View {
    var urls: [URL]

    var body: some View {
        ForEach(urls, id: \.self) { url in
            #if os(tvOS)
            Text(url.host() ?? url.absoluteString).font(.caption).foregroundStyle(.secondary)
            #else
            Link(destination: url) {
                Label(url.host() ?? url.absoluteString, systemImage: "link").font(.caption)
            }
            #endif
        }
    }
}

/// One of the notes the agents keep for each other, loaded with its text when opened.
struct BotFileView: View {
    @Environment(DeskStore.self) private var store
    var file: BotFile
    @State private var loaded: BotFile?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                if let error {
                    Text(error).foregroundStyle(.secondary)
                } else if let text = loaded?.body {
                    if file.isJSON {
                        Text(text).font(.system(.footnote, design: .monospaced)).tvFocusable()
                    } else {
                        MarkdownView(text: text)
                    }
                } else {
                    ProgressView()
                }
            } footer: {
                let f = loaded ?? file
                Text("\(f.path) · version \(f.version) · updated \(Format.dateTime(f.updatedAt))\(f.updatedBy.map { " by \(store.team.displayName($0))" } ?? "")")
            }
            if file.version > 1 {
                Section {
                    NavigationLink(value: FileHistoryRoute(file: file)) {
                        Label("Version history", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
        }
        .navigationTitle(file.name)
        .navigationDestination(for: FileHistoryRoute.self) { FileHistoryView(file: $0.file) }
        .task {
            do {
                loaded = try await store.service.file(path: file.path)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct MarketRow: View {
    var tick: MarketTick

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(tick.symbol ?? tick.tokenId ?? "?").font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.pusd(tick.pricePusd, decimals: 6)).monospacedDigit()
                Text(Format.signedPct(tick.chg24hPct)).font(.caption).monospacedDigit().foregroundStyle(Color.pnl(tick.chg24hPct))
            }
        }
    }

    private var detail: String {
        var parts: [String] = []
        if let tvl = tick.tvlBch { parts.append(String(format: "%.1f BCH TVL", tvl)) }
        if let vol = tick.volumeBch { parts.append(String(format: "%.2f BCH volume", vol)) }
        return parts.joined(separator: " · ")
    }
}

/// One token's price history from the scanners' ticks, with its latest numbers.
struct MarketDetailView: View {
    @Environment(DeskStore.self) private var store
    var tick: MarketTick
    @State private var days = 7
    @State private var ticks: [MarketTick] = []
    @State private var error: String?
    private let ranges = [(1, "24h"), (7, "7d"), (30, "30d"), (90, "90d")]

    var body: some View {
        List {
            Section {
                Picker("Range", selection: $days) {
                    ForEach(ranges, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if let error {
                    Text(error).foregroundStyle(.secondary)
                } else if ticks.filter({ $0.pricePusd != nil }).count < 2 {
                    Text("Not enough ticks yet for a chart.").foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: Metrics.chartHeight)
                } else {
                    chart.frame(height: Metrics.chartHeight)
                }
            }
            .tvFocusable()
            Section {
                LabeledContent("Price", value: Format.pusd(tick.pricePusd, decimals: 8) + " PUSD")
                LabeledContent("24h change") {
                    Text(Format.signedPct(tick.chg24hPct)).foregroundStyle(Color.pnl(tick.chg24hPct))
                }
                if let tvl = tick.tvlBch { LabeledContent("Pool TVL", value: String(format: "%.2f BCH", tvl)) }
                if let vol = tick.volumeBch { LabeledContent("24h volume", value: String(format: "%.4f BCH", vol)) }
                LabeledContent("As of", value: Format.relative(tick.ts))
            }
            .tvFocusable()
            if let tokenId = tick.tokenId, let token = store.tokens.first(where: { $0.tokenId == tokenId }) {
                Section {
                    NavigationLink(value: token) { TokenRow(token: token) }
                }
            }
        }
        .navigationTitle(tick.symbol ?? "Market")
        .task(id: days) { await load() }
    }

    private var chart: some View {
        let points = ticks.compactMap { t in t.pricePusd.map { (ts: t.ts, price: $0) } }
        let up = (points.last?.price ?? 0) >= (points.first?.price ?? 0)
        let color: Color = up ? .up : .down
        return Chart {
            ForEach(Array(points.enumerated()), id: \.offset) { _, p in
                LineMark(x: .value("Time", p.ts), y: .value("PUSD", p.price))
                    .foregroundStyle(color)
                    .interpolationMethod(.monotone)
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
    }

    private func load() async {
        guard let tokenId = tick.tokenId else { return }
        do {
            ticks = try await store.service.ticks(token: tokenId, days: days)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct BriefingRoute: Hashable {}

/// The full JSON Grok Bot read at its latest briefing.
struct BriefingView: View {
    @Environment(DeskStore.self) private var store
    @State private var text: String?
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                if let error {
                    Text(error).foregroundStyle(.secondary)
                } else if let text {
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        #if !os(tvOS)
                        .textSelection(.enabled)
                        #endif
                        .tvFocusable()
                } else if loaded {
                    Text("Grok Bot hasn't read a briefing yet.").foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            } footer: {
                Text("Everything the desk handed Grok Bot at the start of its latest cycle: market data, positions, limits and the team's notes.")
            }
        }
        .navigationTitle("Latest briefing")
        .task {
            do {
                text = try await store.service.briefing()
            } catch {
                self.error = error.localizedDescription
            }
            loaded = true
        }
    }
}

struct FileHistoryRoute: Hashable {
    var file: BotFile
}

struct FileHistoryView: View {
    @Environment(DeskStore.self) private var store
    var file: BotFile
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
                        Text("\(store.team.displayName(v.updatedBy)) · \(v.updatedAt.map(Format.dateTime) ?? "–")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("\(file.name) history")
        .navigationDestination(for: KnowledgeVersion.self) { v in
            KnowledgeVersionView(title: "\(file.name) v\(v.version)", text: v.body, isJSON: file.isJSON)
        }
        .task {
            do {
                versions = try await store.service.fileHistory(path: file.path)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
