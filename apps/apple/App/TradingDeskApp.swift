import SwiftUI
import DeskKit

@main
struct TradingDeskApp: App {
    @State private var store = DeskStore(service: AppConfig.service(for: AppConfig.savedURL))

    var body: some Scene {
        #if os(macOS)
        WindowGroup {
            RootView().environment(store)
        }
        .defaultSize(width: 1180, height: 800)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Refresh") { Task { await store.refresh() } }
                    .keyboardShortcut("r")
            }
        }

        Settings {
            SettingsView()
                .environment(store)
                .frame(width: 480)
        }
        #else
        WindowGroup {
            RootView().environment(store)
        }
        #endif
    }
}

enum AppConfig {
    static let urlKey = "deskURL"
    static let intervalKey = "refreshSeconds"
    static let defaultInterval = 30.0

    static var savedURL: String {
        UserDefaults.standard.string(forKey: urlKey) ?? ""
    }

    /// An empty URL means demo data, so the app is useful before the Worker is deployed.
    static func service(for urlString: String) -> any DeskService {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let client = try? DeskClient(urlString: trimmed) else { return DemoDesk() }
        return client
    }
}
