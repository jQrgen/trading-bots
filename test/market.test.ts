import { describe, expect, it } from "vitest";
import { PUSD } from "../src/config";
import { Prices, simulateSwap } from "../src/market";
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

describe("parseJson", () => {
  it("extracts JSON from a chatty reply", () => {
    expect(parseJson<{ a: number }>('Sure! ```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => parseJson("nothing")).toThrow();
  });
});
