import XCTest
@testable import DeskKit

/// Fixtures use the exact shapes the Worker returns (src/index.ts on feat/paper-launch).
final class DecodingTests: XCTestCase {
    let decoder = DeskDecoder.make()

    func testState() throws {
        let json = """
        {"mode":"paper","halted":false,"start_pusd":1000,"total_pusd":1012.5,"updated_at":1761220800000,"bch_pusd":340.2,
         "holdings":[{"asset":"pusd","symbol":"PUSD","amount":90000,"value_pusd":900},{"asset":"abc","symbol":"ABC","amount":5,"value_pusd":112.5}],
         "positions":[{"id":3,"token_id":"abc","symbol":"ABC","horizon":"short","amount":5,"cost_pusd":100,"entry_price_pusd":20,
                       "target_pct":20,"stop_pct":8,"thesis":"x","opened_at":1761217200000,"closed_at":null,"exit_pusd":null,
                       "close_reason":null,"status":"open","value_pusd":112.5,"pnl_pct":12.5}],
         "agents":[{"agent":"orin","status":"scanning","updated_at":1761220700000}],
         "stats":{"closed":4,"wins":3,"win_rate":0.75,"realized_pusd":7.25}}
        """
        let s = try decoder.decode(DeskState.self, from: Data(json.utf8))
        XCTAssertEqual(s.mode, .paper)
        XCTAssertFalse(s.halted)
        XCTAssertEqual(s.totalPusd, 1012.5)
        XCTAssertEqual(s.pnlAllPusd, 12.5)
        XCTAssertEqual(s.updatedAt, Date(timeIntervalSince1970: 1_761_220_800))
        XCTAssertEqual(s.holdings.count, 2)
        XCTAssertEqual(s.positions.first?.pnlPusd, 12.5)
        XCTAssertEqual(s.positions.first?.targetPct, 20)
        XCTAssertEqual(s.agents.first?.agent, "orin")
        XCTAssertEqual(s.stats.winRate, 0.75)
    }

    func testStateBeforeFirstCycle() throws {
        let json = """
        {"mode":"paper","halted":true,"start_pusd":1000,"total_pusd":null,"updated_at":null,"bch_pusd":null,
         "holdings":[],"positions":[],"agents":[],"stats":{"closed":0,"wins":0,"win_rate":null,"realized_pusd":0}}
        """
        let s = try decoder.decode(DeskState.self, from: Data(json.utf8))
        XCTAssertTrue(s.halted)
        XCTAssertNil(s.totalPusd)
        XCTAssertNil(s.pnlAllPusd)
        XCTAssertNil(s.stats.winRate)
    }

    func testEventsSkipBadRows() throws {
        let json = """
        [{"id":9,"ts":1761220800000,"cycle":4,"agent":"kade","kind":"risk-fail","message":"too thin","data":"{\\"tvl\\":3}"},
         {"id":"broken"},
         {"id":8,"ts":1761220700000,"cycle":null,"agent":"desk","kind":"start","message":"Cycle 4","data":null}]
        """
        let rows = try decoder.decode(LossyArray<DeskEvent>.self, from: Data(json.utf8)).items
        XCTAssertEqual(rows.map(\.id), [9, 8])
        XCTAssertEqual(rows[0].kind, "risk-fail")
        XCTAssertEqual(rows[0].prettyData, "{\n  \"tvl\" : 3\n}")
    }

    func testTradesAndSnapshots() throws {
        let trades = """
        [{"id":1,"ts":1761220800000,"cycle":2,"mode":"paper","side":"buy","token_id":"abc","symbol":"ABC","amount":5,
          "pusd":100,"price_pusd":20,"impact_pct":0.6,"estimated":1,"position_id":3,"reason":"breakout"}]
        """
        let t = try decoder.decode(LossyArray<Trade>.self, from: Data(trades.utf8)).items
        XCTAssertEqual(t.first?.isBuy, true)
        XCTAssertEqual(t.first?.estimated, true)
        XCTAssertEqual(t.first?.mode, .paper)

        let snaps = #"[{"ts":1761217200000,"total_pusd":1000,"bch_pusd":339},{"ts":1761220800000,"total_pusd":1012.5,"bch_pusd":340}]"#
        let s = try decoder.decode(LossyArray<Snapshot>.self, from: Data(snaps.utf8)).items
        XCTAssertEqual(s.map(\.totalPusd), [1000, 1012.5])
    }

    func testJournalLessonsFromJSONString() throws {
        let json = #"[{"id":1,"ts":1761220800000,"text":"Good day","lessons":"[\"Size down in thin pools\",\"Trust Kade\"]"}]"#
        let j = try decoder.decode(LossyArray<JournalEntry>.self, from: Data(json.utf8)).items
        XCTAssertEqual(j.first?.lessons, ["Size down in thin pools", "Trust Kade"])

        let lessons = #"[{"id":2,"ts":1761220800000,"lesson":"Trust Kade","status":"rejected"}]"#
        let l = try decoder.decode(LossyArray<Lesson>.self, from: Data(lessons.utf8)).items
        XCTAssertEqual(l.first?.isActive, false)
    }

    func testDateFormats() throws {
        struct Box: Decodable { var at: Date }
        for raw in ["1761220800000", "1761220800", "\"2025-10-23T12:00:00Z\"", "\"2025-10-23T12:00:00.000Z\"", "\"2025-10-23 12:00:00\""] {
            let box = try decoder.decode(Box.self, from: Data("{\"at\":\(raw)}".utf8))
            XCTAssertEqual(box.at, Date(timeIntervalSince1970: 1_761_220_800), raw)
        }
    }
}

final class ClientTests: XCTestCase {
    func testURLNormalisation() throws {
        let c = try DeskClient(urlString: " cauldron-trading-desk.example.workers.dev/ ")
        XCTAssertEqual(c.baseURL.absoluteString, "https://cauldron-trading-desk.example.workers.dev")
        XCTAssertEqual(c.url("api/events", ["after": "5", "limit": "300"]).absoluteString,
                       "https://cauldron-trading-desk.example.workers.dev/api/events?after=5&limit=300")
        XCTAssertEqual(try DeskClient(urlString: "http://localhost:8787").url("api/state").absoluteString,
                       "http://localhost:8787/api/state")
        XCTAssertThrowsError(try DeskClient(urlString: "ftp://nope"))
    }
}

@MainActor
final class StoreTests: XCTestCase {
    func testRefreshWithDemoData() async {
        let store = DeskStore(service: DemoDesk())
        await store.refresh()
        XCTAssertNil(store.lastError)
        XCTAssertEqual(store.state?.mode, .paper)
        XCTAssertEqual(store.agentCards.count, 6)
        XCTAssertNotNil(store.agentCards.first { $0.id == "kade" }?.status)
        XCTAssertFalse(store.events.isEmpty)
        XCTAssertEqual(store.events.map(\.id), store.events.map(\.id).sorted(by: >))
        XCTAssertEqual(store.openPositions.count, 2)
        XCTAssertEqual(store.closedPositions.count, 2)
        XCTAssertEqual(store.marketMood.map(\.subject), ["bch", "cauldron"])
        XCTAssertEqual(store.notes(about: "furu").first?.verdict, "opportunity")
        XCTAssertEqual(store.mood(about: "dogecash").count, 1)
        XCTAssertFalse(store.tokens.isEmpty)
        XCTAssertTrue(store.files.allSatisfy { $0.body == nil }, "the list call has no file text")
        let file = try? await store.service.file(path: "notes/watchlist.md")
        XCTAssertNotNil(file?.body)

        // A second refresh only asks for newer events and must not duplicate.
        let count = store.events.count
        await store.refresh()
        XCTAssertEqual(store.events.count, count)
    }

    func testEventMergeDedupesAndCaps() {
        let store = DeskStore(service: DemoDesk())
        let t = Date()
        store.merge(events: [DeskEvent(id: 2, ts: t, cycle: nil, agent: "orin", kind: "scan", message: "b"),
                             DeskEvent(id: 1, ts: t, cycle: nil, agent: "orin", kind: "scan", message: "a")])
        store.merge(events: [DeskEvent(id: 3, ts: t, cycle: nil, agent: "vela", kind: "proposal", message: "c"),
                             DeskEvent(id: 2, ts: t, cycle: nil, agent: "orin", kind: "scan", message: "b")])
        XCTAssertEqual(store.events.map(\.id), [3, 2, 1])

        store.merge(events: (10..<(10 + DeskStore.maxEvents + 50)).map {
            DeskEvent(id: $0, ts: t, cycle: nil, agent: "desk", kind: "note", message: "")
        })
        XCTAssertEqual(store.events.count, DeskStore.maxEvents)
        XCTAssertEqual(store.events.first?.id, 10 + DeskStore.maxEvents + 49)
    }

    func testFailingServiceKeepsDataAndReportsError() async {
        struct Down: DeskService {
            func state() async throws -> DeskState { throw DeskError.http(status: 500, message: "boom") }
            func events(after: Int, limit: Int) async throws -> [DeskEvent] { throw DeskError.http(status: 500, message: nil) }
            func snapshots(days: Int) async throws -> [Snapshot] { [] }
            func trades() async throws -> [Trade] { [] }
            func positions() async throws -> [Position] { [] }
            func journal() async throws -> [JournalEntry] { [] }
            func lessons() async throws -> [Lesson] { [] }
            func team() async throws -> TeamRoster { throw DeskError.http(status: 500, message: nil) }
            func knowledge() async throws -> [KnowledgeEntry] { [] }
            func knowledgeHistory(key: String) async throws -> [KnowledgeVersion] { [] }
            func scorecard() async throws -> Scorecard? { nil }
            func proposals(limit: Int) async throws -> [Proposal] { [] }
            func agentCalls(agent: String?, limit: Int) async throws -> [AgentCall] { [] }
            func agentCall(id: Int) async throws -> AgentCall { throw DeskError.http(status: 404, message: nil) }
            func tokens() async throws -> [TokenSeen] { [] }
            func research(token: String?) async throws -> [ResearchNote] { [] }
            func sentiment(subject: String?) async throws -> [SentimentReading] { [] }
            func launchpad() async throws -> [LaunchpadSale] { [] }
            func files() async throws -> [BotFile] { [] }
            func file(path: String) async throws -> BotFile { throw DeskError.http(status: 404, message: nil) }
        }
        let store = DeskStore(service: Down())
        await store.refresh()
        XCTAssertEqual(store.lastError, "The desk answered 500: boom.")
        XCTAssertNil(store.state)
        XCTAssertEqual(store.team, Team.fallback, "keeps the built-in team when /api/team fails")
    }
}

final class TeamTests: XCTestCase {
    func testFallbackGraph() {
        let t = Team.fallback
        XCTAssertEqual(t.members.map(\.id), ["nova", "orin", "vela", "kade", "rune", "zara"])
        XCTAssertEqual(t.reports(of: "human").map(\.id), ["nova"])
        XCTAssertEqual(t.reports(of: "nova").map(\.id), ["vela", "kade", "rune", "zara"])
        XCTAssertEqual(t.reports(of: "vela").map(\.id), ["orin"])
        XCTAssertTrue(t.member("KADE")?.hasVeto == true)
        XCTAssertEqual(t.member("vela")?.horizonLabel, "Medium / long")
        XCTAssertEqual(t.member("nova")?.horizonLabel, "All")
    }

    func testTeamFromAPI() throws {
        let json = """
        {"owner":"human","loop":["orin","nova"],"agents":[
          {"id":"nova","name":"Nova","role":"Head trader","horizons":["short","medium","long"],"reports_to":["human"],"veto":false,"tools":["approve"],"status":"thinking","status_at":1761220800000},
          {"id":"orin","name":"Orin","role":"Scanner","horizons":["short"],"reports_to":["nova"],"veto":true,"tools":[],"status":null,"status_at":null}]}
        """
        let t = try DeskDecoder.make().decode(TeamRoster.self, from: Data(json.utf8))
        XCTAssertEqual(t.members.map(\.number), [1, 2])
        XCTAssertEqual(t.member("nova")?.status, "thinking")
        XCTAssertEqual(t.member("nova")?.tools, ["approve"])
        XCTAssertEqual(t.member("orin")?.hasVeto, true)
        XCTAssertEqual(t.reports(of: "nova").map(\.id), ["orin"])
        XCTAssertEqual(t.displayName("human"), "You")
    }
}

final class KnowledgeTests: XCTestCase {
    let decoder = DeskDecoder.make()

    func testKnowledgeAndScorecard() throws {
        let k = ##"[{"key":"role:kade","title":"Kade","kind":"role","format":"markdown","body":"# Kade","version":2,"updated_by":"owner","updated_at":1761220800000},{"key":"risk-limits","title":"Risk","kind":"risk","format":"json","body":"{}","version":1,"updated_by":"seed","updated_at":1761220800000}]"##
        let entries = try decoder.decode(LossyArray<KnowledgeEntry>.self, from: Data(k.utf8)).items
        XCTAssertEqual(entries.map(\.roleAgent), ["kade", nil])
        XCTAssertEqual(entries[1].isJSON, true)
        XCTAssertEqual(entries[0].updatedBy, "owner")

        let sc = #"{"ts":1761220800000,"window_days":30,"overall":{"trades":4,"win_rate":0.5,"avg_pnl_pct":2.5,"pnl_pusd":10},"by_horizon":{"short":{"trades":4,"win_rate":0.5,"avg_pnl_pct":2.5,"pnl_pusd":10}},"by_signal":{}}"#
        let card = try decoder.decode(Scorecard?.self, from: Data(sc.utf8))
        XCTAssertEqual(card?.overall.winRate, 0.5)
        XCTAssertEqual(card?.byHorizon["short"]?.trades, 4)
        XCTAssertNil(try decoder.decode(Scorecard?.self, from: Data("null".utf8)))
    }

    func testProposalsAndCalls() throws {
        let p = #"[{"id":"abc","ts":1761220800000,"cycle":3,"agent":"vela","action":"buy","token_id":"t","symbol":"ABC","horizon":"short","size_pct":2,"target_pct":20,"stop_pct":8,"signal":"breakout","thesis":"x","bull_case":"up","bear_case":"down","status":"risk_failed","allowed_pusd":null,"risk_notes":"thin","decision_note":null,"position_id":null},{"id":7,"ts":1761220800000,"symbol":"N","status":"filled"}]"#
        let props = try decoder.decode(LossyArray<Proposal>.self, from: Data(p.utf8)).items
        XCTAssertEqual(props.map(\.id), ["abc", "7"])
        XCTAssertEqual(props[0].statusLabel, "risk failed")
        XCTAssertEqual(props[0].bearCase, "down")

        let c = #"{"id":5,"ts":1761220800000,"cycle":1,"agent":"orin","model":"grok-4","search":1,"system_prompt":"You are Orin","input":"in","output":null,"error":"timeout","ms":30000}"#
        let call = try decoder.decode(AgentCall.self, from: Data(c.utf8))
        XCTAssertTrue(call.search)
        XCTAssertEqual(call.systemPrompt, "You are Orin")
        XCTAssertEqual(call.error, "timeout")
    }

    func testJSONRows() {
        let rows = JSONRows.rows(#"{"maxPositionPct":{"short":3,"long":20},"min_trade_pusd":5,"allow":true,"tags":["a","b"]}"#)
        XCTAssertEqual(rows.map(\.label), ["Allow", "Max position pct · Long", "Max position pct · Short", "Min trade pusd", "Tags"])
        XCTAssertEqual(rows.map(\.value), ["yes", "20", "3", "5", "a, b"])
    }
}

final class DiscoveryTests: XCTestCase {
    let decoder = DeskDecoder.make()

    func testTokensAndLaunchpad() throws {
        let t = #"[{"token_id":"abc","symbol":"ABC","name":null,"source":"launchpad","first_seen":1761220800000,"first_pool_ts":null,"last_tvl_bch":12.5,"research_status":"watch","last_research_at":1761224400000},{"symbol":"BAD"}]"#
        let tokens = try decoder.decode(LossyArray<TokenSeen>.self, from: Data(t.utf8)).items
        XCTAssertEqual(tokens.map(\.id), ["abc"])
        XCTAssertEqual(tokens[0].lastTvlBch, 12.5)
        XCTAssertEqual(tokens[0].researchStatus, "watch")
        XCTAssertNil(tokens[0].name)

        let l = #"[{"id":"sale1","offered_token_id":"abc","status":"open","data":"{\"cap_bch\":50}","first_seen":1761220800000,"updated_at":1761220800000}]"#
        let sales = try decoder.decode(LossyArray<LaunchpadSale>.self, from: Data(l.utf8)).items
        XCTAssertEqual(sales.first?.offeredTokenId, "abc")
        XCTAssertEqual(JSONRows.rows(sales[0].data).first?.value, "50")
    }

    func testResearchAndSentiment() throws {
        let r = #"[{"id":3,"ts":1761220800000,"cycle":7,"agent":"vela","token_id":"abc","symbol":"ABC","verdict":"opportunity","opportunity":"listing wave","note":"deep pool","sources":"[\"https://x.com/abc\",\"not a url\"]"}]"#
        let notes = try decoder.decode(LossyArray<ResearchNote>.self, from: Data(r.utf8)).items
        XCTAssertEqual(notes.first?.verdict, "opportunity")
        XCTAssertEqual(notes.first?.sources, [URL(string: "https://x.com/abc")!])

        let s = #"[{"id":1,"ts":1761220800000,"cycle":7,"subject":"bch","token_id":null,"symbol":null,"score":1.7,"mentions":120,"summary":"bullish","sources":null},{"id":2,"ts":1761220800000,"subject":"token","token_id":"abc","symbol":"ABC","score":-0.3,"summary":"meh"}]"#
        let readings = try decoder.decode(LossyArray<SentimentReading>.self, from: Data(s.utf8)).items
        XCTAssertEqual(readings.map(\.title), ["BCH market", "ABC"])
        XCTAssertEqual(readings[0].score, 1, "clamped to +1")
        XCTAssertEqual(readings[0].moodLabel, "Very positive")
        XCTAssertEqual(readings[1].moodLabel, "Negative")
        XCTAssertTrue(readings[1].sources.isEmpty)
    }

    func testFiles() throws {
        let list = #"[{"path":"notes/watch list.md","content_type":"text/markdown","version":2,"updated_by":"vela","updated_at":1761220800000,"bytes":42}]"#
        let files = try decoder.decode(LossyArray<BotFile>.self, from: Data(list.utf8)).items
        XCTAssertEqual(files.first?.name, "watch list.md")
        XCTAssertEqual(files.first?.bytes, 42)
        XCTAssertNil(files.first?.body)

        let one = #"{"path":"plan.json","body":"{}","content_type":"application/json","version":1,"updated_by":null,"updated_at":1761220800000}"#
        let file = try decoder.decode(BotFile.self, from: Data(one.utf8))
        XCTAssertTrue(file.isJSON)
        XCTAssertEqual(file.body, "{}")
        XCTAssertEqual(file.bytes, 2)

        let client = try DeskClient(urlString: "desk.example.dev")
        XCTAssertEqual(client.url("api/research", ["token": "abc"]).absoluteString, "https://desk.example.dev/api/research?token=abc")
    }
}
