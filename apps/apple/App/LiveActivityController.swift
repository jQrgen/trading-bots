#if os(iOS)
import ActivityKit
import BackgroundTasks
import DeskKit
import Foundation

/// Keeps one Live Activity on the lock screen and in the Dynamic Island while the desk trades live.
///
/// Updates come from the app itself: every refresh while it's open, and iOS's background app refresh
/// (roughly every 15 minutes or less often, at the system's discretion) while it's closed. The countdown
/// to the next run ticks on its own. iOS ends any Live Activity after 8 hours; opening the app starts a new one.
@MainActor
enum LiveActivityController {
    static let enabledKey = "liveActivity"
    static let refreshTaskID = "com.jqrgen.tradingdesk.refresh"

    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    private static var running: [Activity<DeskActivityAttributes>] {
        Activity<DeskActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
    }

    /// Updates the running activity, or ends it when the desk is no longer live. Starts one only when
    /// `start` is set (the app just came to the foreground), so an activity the owner swiped away stays away.
    static func sync(_ store: DeskStore, start: Bool = false) async {
        let content = (store.service is DemoDesk) ? nil : store.state.flatMap { LiveActivityState(state: $0, dayChange: store.dayChange) }
        let activities = running
        guard isEnabled, let content else {
            for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) }
            return
        }
        let update = ActivityContent(state: content, staleDate: content.staleDate)
        if let activity = activities.first {
            if activity.content.state != content { await activity.update(update) }
            for extra in activities.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
        } else if start, ActivityAuthorizationInfo().areActivitiesEnabled {
            let name = store.state?.runner?.name ?? "Cauldron Trader"
            _ = try? Activity.request(attributes: DeskActivityAttributes(name: name), content: update, pushType: nil)
        }
    }

    static func endAll() async {
        for activity in Activity<DeskActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    /// Asks iOS to wake the app in about 15 minutes to refresh the activity. iOS decides when, if at all.
    static func scheduleRefresh() {
        guard isEnabled, !running.isEmpty else { return }
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskID)
        request.earliestBeginDate = Date().addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
#endif
