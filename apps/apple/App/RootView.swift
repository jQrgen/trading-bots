import SwiftUI
import DeskKit

enum Screen: String, CaseIterable, Identifiable {
    case overview, agents, activity, trades, playbook, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: "Desk"
        case .agents: "Agents"
        case .activity: "Activity"
        case .trades: "Trades"
        case .playbook: "Playbook"
        case .settings: "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "chart.line.uptrend.xyaxis"
        case .agents: "person.3"
        case .activity: "list.bullet.rectangle"
        case .trades: "arrow.left.arrow.right"
        case .playbook: "book"
        case .settings: "gear"
        }
    }

    @MainActor @ViewBuilder
    var view: some View {
        switch self {
        case .overview: OverviewView()
        case .agents: AgentsView()
        #if os(macOS)
        case .activity: MacActivityView()
        case .trades: MacTradesView()
        #else
        case .activity: ActivityView()
        case .trades: TradesView()
        #endif
        case .playbook: PlaybookView()
        case .settings: SettingsView()
        }
    }

    /// Settings lives in the app menu on macOS and behind a toolbar button on iOS.
    static var navigable: [Screen] {
        #if os(tvOS)
        allCases
        #else
        allCases.filter { $0 != .settings }
        #endif
    }
}

struct RootView: View {
    #if os(macOS)
    @State private var selection: Screen? = .overview
    #endif

    var body: some View {
        #if os(macOS)
        NavigationSplitView {
            List(Screen.navigable, selection: $selection) { screen in
                Label(screen.title, systemImage: screen.symbol).tag(screen)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 200)
            .safeAreaInset(edge: .bottom) { RefreshFooter().padding() }
        } detail: {
            NavigationStack {
                (selection ?? .overview).view
            }
        }
        .focusedSceneValue(\.screenSelection, $selection)
        #else
        TabView {
            ForEach(Screen.navigable) { screen in
                NavigationStack {
                    screen.view
                }
                .tabItem { Label(screen.title, systemImage: screen.symbol) }
                .tag(screen)
            }
        }
        #endif
    }
}

/// "Updated 2 min ago" with a spinner while refreshing.
struct RefreshFooter: View {
    @Environment(DeskStore.self) private var store

    var body: some View {
        HStack(spacing: 6) {
            if store.isLoading {
                ProgressView()
                    #if !os(tvOS)
                    .controlSize(.small)
                    #endif
            }
            if let last = store.lastRefresh {
                Text("Updated \(last, style: .relative) ago")
            } else {
                Text(store.isLoading ? "Loading…" : "Not loaded yet")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Toolbar shared by the iOS and macOS screens: refresh, plus Settings on iOS.
struct DeskToolbar: ViewModifier {
    @Environment(DeskStore.self) private var store
    @State private var showSettings = false

    func body(content: Content) -> some View {
        #if os(tvOS)
        content
        #else
        content
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(store.isLoading)
                }
                #if os(iOS)
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showSettings = true
                    } label: {
                        Label("Settings", systemImage: "gear")
                    }
                }
                #endif
            }
            #if os(iOS)
            .refreshable { await store.refresh() }
            .sheet(isPresented: $showSettings) {
                NavigationStack {
                    SettingsView()
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) { Button("Done") { showSettings = false } }
                        }
                }
            }
            #endif
        #endif
    }
}

extension View {
    func deskToolbar() -> some View { modifier(DeskToolbar()) }
}
