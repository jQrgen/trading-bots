import { describe, expect, it } from "vitest";
import { PUSD } from "../src/config";
import { Prices, routePools, satsOut, simulateSwap, tokensOut } from "../src/market";
import { parseJson } from "../src/grok";
import type { TokenInfo } from "../src/cauldron";

const TOK = "a".repeat(64);
const tokens = new Map<string, TokenInfo>([
  [PUSD, { token_id: PUSD, tvl_sats: 45e9, tvl_tokens: 1.28e7, price_now: 350_000, bcmr: { token: { decimals: 2 } } }],
  [TOK, { token_id: TOK, tvl_sats: 10e8, tvl_tokens: 1e9, price_now: 1000, bcmr: { token: { decimals: 0 } } }],
]);

describe("Prices", () => {
  const p = new Prices(tokens);
  it("derives BCH and token prices in PUSD", () => {
    expect(p.bchPusd).toBeCloseTo(285.714, 2);
    expect(p.tokenPusd(TOK)).toBeCloseTo(0.002857, 5);
    expect(p.value(PUSD, 1234)).toBeCloseTo(12.34);
    expect(p.value("bch", 1e8)).toBeCloseTo(285.714, 2);
  });
});

describe("simulateSwap", () => {
  const prices = new Prices(tokens);
  it("routes token trades through BCH and applies the router fee", async () => {
    const calls: string[] = [];
    const quote = async (sell: string, buy: string, amount: bigint) => {
      calls.push(`${sell}->${buy}:${amount}`);
      return { input_amount: amount.toString(), output_amount: "1000000", market_pre_price: "100", market_post_price: "101" };
    };
    const fill = await simulateSwap(PUSD, TOK, 10000, prices, quote);
    expect(fill.hops).toEqual([PUSD, "bch", TOK]);
    expect(calls[0]).toBe(`${PUSD}->bch:10000`);
    expect(calls[1]).toBe(`bch->${TOK}:999000`);
    expect(fill.amountOut).toBe(999000);
    expect(fill.impactPct).toBeCloseTo(1);
    expect(fill.estimated).toBe(false);
  });

  it("falls back to an estimate with a haircut when the router fails", async () => {
    const quote = async () => { throw new Error("down"); };
    const fill = await simulateSwap(PUSD, TOK, 10000, prices, quote);
    expect(fill.estimated).toBe(true);
    // 100 PUSD is ~35000 tokens at mid; estimate must come in below that.
    expect(fill.amountOut).toBeGreaterThan(30000);
    expect(fill.amountOut).toBeLessThan(35000);
  });
});

describe("pool reserves", () => {
  it("applies the 0.3% fee on a single pool", () => {
    // 1e6 sats, 5e6 tokens, spend 10_000 sats. fee = 30. Remaining tokens are
    // ceil(k / (sats + dx - fee)) so the pool keeps k; the trader gets 49_357.
    expect(tokensOut(1_000_000n, 5_000_000n, 10_000n)).toBe(49_357n);
    const back = satsOut(1_000_000n, 5_000_000n, 49_357n);
    expect(back).toBeGreaterThan(9_000n);
    expect(back).toBeLessThan(10_000n);
  });

  it("fills from pool reserves when the router quote is about 3x off", async () => {
    // Reserves from the MINTY book (decimals 2) and the PUSD book on 2026-10-23.
    // The live router quoted ~113.5e6 MINTY base units for 20 PUSD; the pools clear ~35e6.
    const minty = "b".repeat(64);
    const book = new Map<string, { sats: number; tokens: number }[]>([
      [PUSD, [{ sats: 44_968_662_085, tokens: 12_860_978 }]],
      [minty, [{ sats: 1_378_269_816, tokens: 7_007_194_153 }]],
    ]);
    const prices = new Prices(new Map([
      [PUSD, { token_id: PUSD, tvl_sats: 45e9, tvl_tokens: 1.28e7, price_now: 349_652, bcmr: { token: { decimals: 2 } } }],
      [minty, { token_id: minty, tvl_sats: 1_378_269_816, tvl_tokens: 7_007_194_153, price_now: 19.669, bcmr: { token: { decimals: 2 } } }],
    ]));
    const quote = async (sell: string) =>
      sell === PUSD
        ? { input_amount: "2000", output_amount: "8963282", market_pre_price: "3461.47", market_post_price: "3461.39" }
        : { input_amount: "8954286", output_amount: "113525741", market_pre_price: "0.15409", market_post_price: "0.15655" };
    const fill = await simulateSwap(PUSD, minty, 2000, prices, quote, async (id) => book.get(id) ?? []);
    expect(fill.reservePriced).toBe(true);
    expect(fill.estimated).toBe(false);
    expect(fill.amountOut).toBeGreaterThan(30_000_000);
    expect(fill.amountOut).toBeLessThan(50_000_000);
    const fair = routePools(book.get(minty)!, routePools(book.get(PUSD)!, 2000n, false).out, true).out;
    expect(fill.amountOut).toBeLessThan(Number(fair));
    expect(Number(fair) / fill.amountOut).toBeLessThan(1.01);
  });
});

describe("parseJson", () => {
  it("extracts JSON from a chatty reply", () => {
    expect(parseJson<{ a: number }>('Sure! ```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => parseJson("nothing")).toThrow();
  });
});

describe("routePools remainder", () => {
  it("routes the whole input across many pools", () => {
    const pools = Array.from({ length: 10 }, () => ({ sats: 1e9, tokens: 1e9 }));
    const { out } = routePools(pools, 1_000_000n, true);
    expect(Number(out)).toBeGreaterThan(1_000_000 * 0.99);
  });
});
