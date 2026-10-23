#if os(iOS)
import ActivityKit
import DeskKit

/// Shared by the app (which starts and updates the activity) and the widget extension (which draws it).
struct DeskActivityAttributes: ActivityAttributes {
    typealias ContentState = LiveActivityState
    var name: String
}
#endif
