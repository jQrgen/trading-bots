import Foundation

public enum Format {
    /// "1,234.56"
    public static func pusd(_ value: Double?, decimals: Int = 2) -> String {
        guard let value, value.isFinite else { return "–" }
        return value.formatted(.number.precision(.fractionLength(decimals)))
    }

    /// "+12.30" / "-4.00"
    public static func signed(_ value: Double?, decimals: Int = 2) -> String {
        guard let value, value.isFinite else { return "–" }
        return (value > 0 ? "+" : "") + pusd(value, decimals: decimals)
    }

    /// "+3.4%"
    public static func signedPct(_ value: Double?, decimals: Int = 1) -> String {
        guard let value, value.isFinite else { return "–" }
        return signed(value, decimals: decimals) + "%"
    }

    /// 0.55 -> "55%"
    public static func ratio(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "–" }
        return (value * 100).formatted(.number.precision(.fractionLength(0))) + "%"
    }

    public static func relative(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "never" }
        if now.timeIntervalSince(date) < 60 { return "just now" }
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    public static func time(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    public static func dateTime(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}
