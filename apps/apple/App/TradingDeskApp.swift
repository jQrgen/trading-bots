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
    /// Renamed from "deskURL" when the live desk became the default, so a value saved by an older build
    /// (such as an empty one, which means demo data) can't keep the app on demo data.
    static let urlKey = "deskURL2"
    static let intervalKey = "refreshSeconds"
    static let defaultInterval = 30.0
    /// The live desk. Settings can point elsewhere (e.g. `wrangler dev`) or switch to demo data.
    static let defaultURL = "https://cauldron-trading-desk.nordiccrypto.workers.dev"

    static var interval: Double {
        let v = UserDefaults.standard.double(forKey: intervalKey)
        return v >= 5 ? v : defaultInterval
    }

    static var savedURL: String {
        UserDefaults.standard.string(forKey: urlKey) ?? defaultURL
    }

    /// An empty URL means demo data.
    static func service(for urlString: String) -> any DeskService {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let client = try? DeskClient(urlString: trimmed) else { return DemoDesk() }
        return client
    }
}
