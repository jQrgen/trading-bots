import SwiftUI
import DeskKit

struct SettingsView: View {
    @Environment(DeskStore.self) private var store
    @AppStorage(AppConfig.urlKey) private var savedURL = ""
    @AppStorage(AppConfig.intervalKey) private var interval = AppConfig.defaultInterval
    @State private var draft = ""
    @State private var check: String?

    var body: some View {
        Form {
            Section {
                TextField("https://cauldron-trading-desk.<you>.workers.dev", text: $draft)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit(apply)
                Button("Connect", action: apply)
                    .disabled(draft.trimmingCharacters(in: .whitespaces) == savedURL)
                if !savedURL.isEmpty {
                    Button("Use demo data instead", role: .destructive) {
                        draft = ""
                        apply()
                    }
                }
                if let check {
                    Text(check).font(.callout).foregroundStyle(.secondary)
                }
            } header: {
                Text("Desk")
            } footer: {
                Text("The Cloudflare Worker that runs the bots. Leave empty to see demo data. The app only reads; it can't trade or halt the desk.")
            }

            Section("Refresh") {
                Picker("Every", selection: $interval) {
                    Text("15 seconds").tag(15.0)
                    Text("30 seconds").tag(30.0)
                    Text("1 minute").tag(60.0)
                    Text("5 minutes").tag(300.0)
                }
            }
        }
        .navigationTitle("Settings")
        .onAppear { draft = savedURL }
    }

    private func apply() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, (try? DeskClient(urlString: trimmed)) == nil {
            check = "That doesn't look like a URL."
            return
        }
        savedURL = trimmed
        check = trimmed.isEmpty ? "Using demo data." : "Connecting…"
        Task {
            await store.use(AppConfig.service(for: trimmed))
            if !trimmed.isEmpty {
                check = store.lastError.map { "Couldn't reach the desk: \($0)" } ?? "Connected."
            }
        }
    }
}
