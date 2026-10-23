import Foundation

// Models for live trading (src/live.ts): the bots' wallet and explorer links.

/// GET /api/wallet — the desk's own on-chain wallet. Read-only: the app never moves funds.
public struct WalletInfo: Decodable, Hashable, Sendable {
    public struct Token: Decodable, Hashable, Sendable {
        public var category: String
        public var amount: Double
    }

    public var mode: TradingMode
    public var frozen: Bool
    /// False until the wallet seed is set on the Worker.
    public var hasSecret: Bool
    public var liveSince: Date?
    public var address: String?
    public var tokenAddress: String?
    public var bchSats: Double?
    public var pusd: Double?
    public var tokens: [Token]
    /// Number of unspent coins the wallet holds.
    public var coins: Int?
    /// Set when the wallet couldn't be read.
    public var error: String?

    public init(mode: TradingMode, frozen: Bool = false, hasSecret: Bool = true, liveSince: Date? = nil, address: String? = nil,
                tokenAddress: String? = nil, bchSats: Double? = nil, pusd: Double? = nil, tokens: [Token] = [], coins: Int? = nil,
                error: String? = nil) {
        self.mode = mode
        self.frozen = frozen
        self.hasSecret = hasSecret
        self.liveSince = liveSince
        self.address = address
        self.tokenAddress = tokenAddress
        self.bchSats = bchSats
        self.pusd = pusd
        self.tokens = tokens
        self.coins = coins
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = (try? c.decodeIfPresent(TradingMode.self, forKey: .mode)) ?? .unknown
        frozen = (try? c.decodeIfPresent(FlexBool.self, forKey: .frozen))?.value ?? false
        hasSecret = (try? c.decodeIfPresent(FlexBool.self, forKey: .hasSecret))?.value ?? false
        liveSince = try? c.decodeIfPresent(Date.self, forKey: .liveSince)
        address = try? c.decodeIfPresent(String.self, forKey: .address)
        tokenAddress = try? c.decodeIfPresent(String.self, forKey: .tokenAddress)
        bchSats = try? c.decodeIfPresent(Double.self, forKey: .bchSats)
        pusd = try? c.decodeIfPresent(Double.self, forKey: .pusd)
        tokens = (try? c.decodeIfPresent(LossyArray<Token>.self, forKey: .tokens))?.items ?? []
        coins = try? c.decodeIfPresent(Int.self, forKey: .coins)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }

    enum CodingKeys: String, CodingKey {
        case mode, frozen, hasSecret, liveSince, address, tokenAddress, bchSats, pusd, tokens, coins, error
    }

    public var bch: Double? { bchSats.map { $0 / 100_000_000 } }
}

/// Nordic Crypto's block explorer, which the owner chose. Its search opens the transaction or address it finds.
public enum Explorer {
    public static func url(_ query: String) -> URL? {
        var c = URLComponents(string: "https://explorer.nordiccrypto.no/search/")
        c?.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "chain", value: "bch")]
        return c?.url
    }
}
