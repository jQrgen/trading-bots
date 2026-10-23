import SwiftUI
import DeskKit

@main
struct TradingDeskApp: App {
    @State private var store: DeskStore

    init() {
        let store = DeskStore(service: AppConfig.service(for: AppConfig.savedURL))
        _store = State(initialValue: store)
        // Poll for the app's whole life, so the Mac menu bar stays current with the window closed.
        Task { await store.poll(every: { AppConfig.interval }) }
    }

    var body: some Scene {
        #if os(macOS)
        WindowGroup("Trading Desk", id: "desk") {
            RootView()
                .environment(store)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1240, height: 820)
        .commands { DeskCommands(store: store) }

        MenuBarExtra {
            MenuBarPanel().environment(store)
        } label: {
            MenuBarLabel().environment(store)
        }
        .menuBarExtraStyle(.window)

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

    static var interval: Double {
        let v = UserDefaults.standard.double(forKey: intervalKey)
        return v >= 5 ? v : defaultInterval
    }

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
