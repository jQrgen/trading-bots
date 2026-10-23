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
        XCTAssertNil(s.runner)
    }

    func testRunner() throws {
        let json = """
        {"mode":"paper","halted":false,"holdings":[],"positions":[],"agents":[],"stats":{"closed":0,"wins":0},
         "runner":{"name":"Cauldron Trader","brain":"grok-bot","cycle":27,"state":"complete","updated_at":1761220800000,"next_run_at":1761221700000,"next_journal_at":1761238800000}}
        """
        let s = try decoder.decode(DeskState.self, from: Data(json.utf8))
        XCTAssertEqual(s.runner?.name, "Cauldron Trader")
        XCTAssertEqual(s.runner?.cycle, 27)
        XCTAssertEqual(s.runner?.state, "complete")
        XCTAssertTrue(s.runner?.summary.contains("cycle 27") == true)
        XCTAssertTrue(s.runner?.summary.contains("done") == true)

        let runner = try XCTUnwrap(s.runner)
        let due = try XCTUnwrap(runner.nextRunAt)
        XCTAssertFalse(runner.isOverdue(now: due.addingTimeInterval(60)))
        XCTAssertTrue(runner.isOverdue(now: due.addingTimeInterval(5 * 60)))
        XCTAssertTrue(runner.summary(now: due.addingTimeInterval(5 * 60)).contains("next run overdue (was due 12:15 UTC)"))
        var running = runner
        running.state = "running"
        XCTAssertFalse(running.isOverdue(now: due.addingTimeInterval(5 * 60)))
        let flagged = try decoder.decode(RunnerStatus.self, from: Data(#"{"state":"complete","next_run_at":1761221700000,"overdue":false}"#.utf8))
        XCTAssertFalse(flagged.isOverdue(now: due.addingTimeInterval(3600)), "the desk's flag wins")
        let member = try XCTUnwrap(Team.fallback.member("orin"))
        let event = DeskEvent(id: 9, ts: Date(timeIntervalSince1970: 1_761_220_800), cycle: 27, agent: "orin", kind: "scan", message: "Scanned 40 tokens, 8 signals")
        let idle = AgentCard(member: member, status: "idle, waiting for Grok Bot", updatedAt: nil, lastEvent: event)
        XCTAssertEqual(idle.displayStatus, "Cycle 27: Scanned 40 tokens, 8 signals")
        let live = AgentCard(member: member, status: "Cycle 27: 8 signals · next 16:20 UTC", updatedAt: nil, lastEvent: event)
        XCTAssertEqual(live.displayStatus, "Cycle 27: 8 signals · next 16:20 UTC")
    }

    func testLiveRole() throws {
        let json = """
        {"mode":"paper","halted":false,"holdings":[],"positions":[],"agents":[{"agent":"vela","status":"researching","updated_at":1761220800000}],
         "stats":{"closed":0,"wins":0},
         "cycle_running":true,"active_role":"vela","active_since":1761220860000,"step":"Vela research",
         "cycle_banner":"Cycle 27 running, step Vela research",
         "runner":{"name":"Cauldron Trader","cycle":27,"state":"running","next_run_at":1761221700000}}
        """
        let s = try decoder.decode(DeskState.self, from: Data(json.utf8))
        XCTAssertTrue(s.cycleRunning)
        XCTAssertEqual(s.activeRole, "vela")
        XCTAssertEqual(s.step, "Vela research")
        XCTAssertEqual(s.activeSince, Date(timeIntervalSince1970: 1_761_220_860))
        XCTAssertEqual(s.deskBanner, "Cycle 27 running, step Vela research")
        let member = try XCTUnwrap(Team.fallback.member("vela"))
        let card = AgentCard(member: member, status: "researching", updatedAt: s.activeSince, lastEvent: nil, isRunning: true, cycle: 27, activeSince: s.activeSince)
        XCTAssertEqual(card.displayStatus.hasPrefix("Running"), true)
        XCTAssertTrue(card.runningDetail.contains("Cycle 27"))
        XCTAssertTrue(card.runningDetail.contains("since "))
        let idle = DeskState(mode: .paper, halted: false, startPusd: nil, totalPusd: nil, updatedAt: nil, bchPusd: nil,
                             holdings: [], positions: [], agents: [], stats: .init(),
                             runner: RunnerStatus(name: "Cauldron Trader", state: "complete", nextRunAt: Date().addingTimeInterval(600)))
        XCTAssertFalse(idle.cycleRunning)
        XCTAssertTrue(idle.deskBanner.hasPrefix("idle, next run "))
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
        XCTAssertEqual(store.state?.runner?.cycle, 412)
        XCTAssertEqual(store.state?.deskBanner, "Cycle 412 running, step Vela research")
        XCTAssertEqual(store.agentCards.first { $0.id == "vela" }?.isRunning, true)
        XCTAssertTrue(store.agentCards.first { $0.id == "vela" }?.runningDetail.contains("Cycle 412") == true)
        XCTAssertFalse(store.agentCards.contains { $0.id != "vela" && $0.isRunning })
        XCTAssertFalse(store.agentCards.contains { $0.displayStatus.localizedCaseInsensitiveContains("idle, waiting") })
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
        XCTAssertEqual(store.openLiquidity.count, 1)
        XCTAssertEqual(store.closedLiquidity.count, 1)
        XCTAssertEqual(store.review(of: 11)?.process, "minor")
        XCTAssertEqual(store.markets.first?.symbol, "FURU")
        XCTAssertNotNil(store.wallet?.address)
        XCTAssertGreaterThan(store.scorecardHistory.count, 1)
        let ticks = try? await store.service.ticks(token: "furu", days: 7)
        XCTAssertEqual(ticks?.count, 96)
        XCTAssertEqual(ticks.map { $0.map(\.ts) }, ticks.map { $0.map(\.ts).sorted() }, "oldest first")
        let history = try? await store.service.fileHistory(path: "notes/handover.md")
        XCTAssertEqual(history?.first?.version, 12)
        XCTAssertEqual(store.scorecard?.holdingTimes.map { $0.label }, ["1-24h", "1-7d"])

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
            func liquidity() async throws -> [LiquidityPosition] { [] }
            func reviews() async throws -> [TradeReview] { [] }
            func markets() async throws -> [MarketTick] { [] }
            func ticks(token: String, days: Int) async throws -> [MarketTick] { [] }
            func fileHistory(path: String) async throws -> [KnowledgeVersion] { [] }
            func scorecards(days: Int) async throws -> [Scorecard] { [] }
            func briefing() async throws -> String? { nil }
            func wallet() async throws -> WalletInfo { throw DeskError.http(status: 404, message: "not found") }
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

final class LiquidityTests: XCTestCase {
    let decoder = DeskDecoder.make()

    func testLiquidityPositions() throws {
        let json = #"[{"id":1,"token_id":"abc","symbol":"ABC","status":"open","opened_at":1761220800000,"closed_at":null,"deposit_pusd":100,"bch_sats":1000,"tokens":50,"k":50000,"entry_price_sats":20,"stop_pct":8,"fees_pusd":1.5,"last_accrual_ts":1761220800000,"value_pusd":103,"il_pct":-0.4,"signal":"fee-yield","thesis":"busy pool","exit_pusd":null,"close_reason":null},{"id":2,"token_id":"x","symbol":"X","status":"closed","opened_at":1761220800000,"closed_at":1761224400000,"deposit_pusd":50,"value_pusd":49,"exit_pusd":45,"close_reason":"stop"}]"#
        let rows = try decoder.decode(LossyArray<LiquidityPosition>.self, from: Data(json.utf8)).items
        XCTAssertEqual(rows.count, 2)
        XCTAssertTrue(rows[0].isOpen)
        XCTAssertEqual(rows[0].pnlPusd, 3)
        XCTAssertEqual(rows[0].ilPct, -0.4)
        XCTAssertEqual(rows[1].pnlPusd, -5, "a closed position uses its exit")
        XCTAssertEqual(rows[1].pnlPct, -10)
        XCTAssertEqual(rows[1].feesPusd, 0)
    }

    func testReviews() throws {
        let json = #"[{"position_id":7,"ts":1761220800000,"symbol":"ABC","process":"major","break_stage":"sizing","outcome_pusd":-4.5,"outcome_r":-1.6,"stop_overshoot_pct":6.2,"finding":"Sized past the limit.","agent":"zara"}]"#
        let reviews = try decoder.decode(LossyArray<TradeReview>.self, from: Data(json.utf8)).items
        XCTAssertEqual(reviews.first?.id, 7)
        XCTAssertEqual(reviews.first?.breakStage, "sizing")
        XCTAssertEqual(reviews.first?.outcomeR, -1.6)
    }

    func testGrokBotStatusAndHoldingTime() throws {
        let state = #"{"mode":"paper","halted":false,"holdings":[],"positions":[],"agents":[],"stats":{"closed":0,"wins":0},"grok_bot":{"token_created_at":1761220800000,"last_seen":1761224400000,"last_auth_failure":{"ts":1761228000000,"reason":"bad token"}}}"#
        let s = try decoder.decode(DeskState.self, from: Data(state.utf8))
        XCTAssertEqual(s.grokBot?.currentFailure?.reason, "bad token", "a rejection after the last good call is current")

        let ok = #"{"mode":"paper","grok_bot":{"token_created_at":null,"last_seen":1761231600000,"last_auth_failure":{"ts":1761228000000,"reason":"old"}}}"#
        XCTAssertNil(try decoder.decode(DeskState.self, from: Data(ok.utf8)).grokBot?.currentFailure)

        let card = #"{"ts":1761220800000,"window_days":30,"overall":{"trades":3,"win_rate":0.5,"avg_pnl_pct":1,"pnl_pusd":2},"by_horizon":{},"by_signal":{},"by_holding_time":{"over 7d":{"trades":1,"win_rate":1,"avg_pnl_pct":9,"pnl_pusd":5},"under 1h":{"trades":2,"win_rate":0,"avg_pnl_pct":-2,"pnl_pusd":-3}}}"#
        let sc = try decoder.decode(Scorecard.self, from: Data(card.utf8))
        XCTAssertEqual(sc.holdingTimes.map { $0.label }, ["under 1h", "over 7d"])
    }

    func testLiquiditySidesCountAsBuysAndSells() {
        let t = Date()
        XCTAssertTrue(Trade(id: 1, ts: t, mode: .paper, side: "lp-in", tokenId: "a", symbol: "A", amount: 1, pusd: 1, pricePusd: nil,
                            impactPct: nil, estimated: false, positionId: nil, reason: nil).isBuy)
    }
}

final class MarketTests: XCTestCase {
    let decoder = DeskDecoder.make()

    func testMarketsAndTicks() throws {
        let m = #"[{"ts":1761220800000,"token_id":"abc","symbol":"ABC","price_pusd":0.0123,"tvl_bch":30.5,"chg_24h_pct":-4.2,"volume_sats":250000000}]"#
        let markets = try decoder.decode(LossyArray<MarketTick>.self, from: Data(m.utf8)).items
        XCTAssertEqual(markets.first?.id, "abc")
        XCTAssertEqual(markets.first?.chg24hPct, -4.2)
        XCTAssertEqual(markets.first?.volumeBch, 2.5)

        let t = #"[{"ts":1761220800000,"price_pusd":0.01,"tvl_bch":30,"chg_24h_pct":null,"volume_sats":null},{"ts":1761224400000,"price_pusd":0.011}]"#
        let ticks = try decoder.decode(LossyArray<MarketTick>.self, from: Data(t.utf8)).items
        XCTAssertEqual(ticks.count, 2)
        XCTAssertNil(ticks[0].tokenId)
        XCTAssertNotEqual(ticks[0].id, ticks[1].id)
    }

    func testFileHistoryAllowsMissingAuthor() throws {
        let h = ##"[{"version":3,"body":"# v3","updated_by":null,"updated_at":1761220800000},{"version":2,"body":"# v2","updated_by":"vela","updated_at":1761217200000}]"##
        let versions = try decoder.decode(LossyArray<KnowledgeVersion>.self, from: Data(h.utf8)).items
        XCTAssertEqual(versions.map(\.version), [3, 2])
        XCTAssertEqual(versions[1].updatedBy, "vela")
    }

    func testBriefingFormatting() {
        XCTAssertNil(PrettyJSON.format(Data("null".utf8)))
        let pretty = PrettyJSON.format(Data(#"{"b":1,"a":[2]}"#.utf8)) ?? ""
        XCTAssertTrue(pretty.contains("\n"), "pretty-printed")
        XCTAssertLessThan(pretty.range(of: "\"a\"")!.lowerBound, pretty.range(of: "\"b\"")!.lowerBound, "keys sorted")

        let client = try? DeskClient(urlString: "desk.example.dev")
        XCTAssertEqual(client?.url("api/files/notes/a.md", ["history": "1"]).absoluteString, "https://desk.example.dev/api/files/notes/a.md?history=1")
        XCTAssertEqual(client?.url("api/ticks", ["token": "abc", "days": "7"]).absoluteString, "https://desk.example.dev/api/ticks?days=7&token=abc")
    }
}

final class LiveTests: XCTestCase {
    let decoder = DeskDecoder.make()

    func testLiveStateCountsDepositsAsCapital() throws {
        let json = #"{"mode":"live","halted":false,"frozen":true,"live_since":1761220800000,"start_pusd":250.0,"deposits_pusd":200.17,"total_deposited_pusd":249.9,"total_pusd":248.98,"holdings":[],"positions":[],"agents":[],"stats":{"closed":0,"wins":0,"win_rate":null,"realized_pusd":0,"change_24h_pusd":-0.94}}"#
        let s = try decoder.decode(DeskState.self, from: Data(json.utf8))
        XCTAssertEqual(s.mode, .live)
        XCTAssertTrue(s.frozen)
        XCTAssertEqual(s.depositsPusd, 200.17)
        XCTAssertEqual(s.totalDepositedPusd, 249.9)
        XCTAssertNotNil(s.liveSince)
        XCTAssertTrue(s.stats.hasChange24h)
        XCTAssertEqual(s.stats.change24hPusd, -0.94)
        XCTAssertEqual(s.pnlAllPusd!, -1.02, accuracy: 0.0001)

        let none = #"{"mode":"live","stats":{"closed":0,"wins":0,"change_24h_pusd":null}}"#
        let n = try decoder.decode(DeskState.self, from: Data(none.utf8))
        XCTAssertTrue(n.stats.hasChange24h, "null means no snapshot yet, not an old desk")
        XCTAssertNil(n.stats.change24hPusd)

        let old = #"{"mode":"paper","stats":{"closed":1,"wins":1}}"#
        XCTAssertFalse(try decoder.decode(DeskState.self, from: Data(old.utf8)).stats.hasChange24h)
    }

    @MainActor
    func testDayChangePrefersTheDesksNetFigure() async {
        struct Live: DeskService {
            let base = DemoDesk()
            func state() async throws -> DeskState {
                var s = try await base.state()
                s.mode = .live
                s.stats.change24hPusd = -0.94
                s.stats.hasChange24h = true
                return s
            }
            func events(after: Int, limit: Int) async throws -> [DeskEvent] { [] }
            func snapshots(days: Int) async throws -> [Snapshot] { try await base.snapshots(days: days) }
            func trades() async throws -> [Trade] { [] }
            func positions() async throws -> [Position] { [] }
            func journal() async throws -> [JournalEntry] { [] }
            func lessons() async throws -> [Lesson] { [] }
            func team() async throws -> TeamRoster { try await base.team() }
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
            func liquidity() async throws -> [LiquidityPosition] { [] }
            func reviews() async throws -> [TradeReview] { [] }
            func markets() async throws -> [MarketTick] { [] }
            func ticks(token: String, days: Int) async throws -> [MarketTick] { [] }
            func fileHistory(path: String) async throws -> [KnowledgeVersion] { [] }
            func scorecards(days: Int) async throws -> [Scorecard] { [] }
            func briefing() async throws -> String? { nil }
            func wallet() async throws -> WalletInfo { WalletInfo(mode: .live, pusd: 248.9) }
        }
        let store = DeskStore(service: Live())
        await store.refresh()
        XCTAssertEqual(store.dayChange, -0.94)
        XCTAssertEqual(store.wallet?.pusd, 248.9)
    }

    func testWalletAndTxid() throws {
        let w = #"{"mode":"live","frozen":false,"has_secret":true,"live_since":1761220800000,"address":"bitcoincash:qabc","token_address":"bitcoincash:zabc","bch_sats":150000,"pusd":248.9,"tokens":[{"category":"ff00","amount":5}],"coins":3}"#
        let wallet = try decoder.decode(WalletInfo.self, from: Data(w.utf8))
        XCTAssertEqual(wallet.mode, .live)
        XCTAssertEqual(wallet.bch, 0.0015)
        XCTAssertEqual(wallet.tokens.first?.category, "ff00")
        XCTAssertEqual(wallet.coins, 3)

        let noSeed = #"{"mode":"paper","frozen":false,"has_secret":false,"live_since":null,"address":null}"#
        XCTAssertFalse(try decoder.decode(WalletInfo.self, from: Data(noSeed.utf8)).hasSecret)

        let t = #"{"id":9,"ts":1761220800000,"mode":"live","side":"convert","token_id":"pusd","symbol":"PUSD","pusd":200.17,"txid":"abc123"}"#
        let trade = try decoder.decode(Trade.self, from: Data(t.utf8))
        XCTAssertEqual(trade.sideLabel, "CONVERT")
        XCTAssertEqual(trade.txid, "abc123")
        XCTAssertEqual(Explorer.url("abc123")?.absoluteString, "https://explorer.nordiccrypto.no/search/?q=abc123&chain=bch")
    }
}
