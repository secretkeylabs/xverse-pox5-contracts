import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNER_MANAGERS,
  LANES,
  MAINNET_DEPLOYER_ADDRESS,
  assertMainnetDeployerAddress,
  captureBroadcastHttpResponse,
  parseFeeUstx,
  resolveOperators,
} from "../scripts/deploy";

const operator = "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE";

describe("deployment script inputs", () => {
  it("pins deployment to the canonical Xverse PoX-5 address", () => {
    expect(() =>
      assertMainnetDeployerAddress(MAINNET_DEPLOYER_ADDRESS),
    ).not.toThrow();
    expect(() =>
      assertMainnetDeployerAddress(
        "SPXVRSEH2BKSXAEJ00F1BY562P45D5ERPSKR4Q33",
      ),
    ).toThrow(/expected canonical Xverse PoX-5 deployer/);
  });

  it("assigns --op-all to every lane", () => {
    const operators = resolveOperators({ "op-all": operator });

    expect(LANES.map((lane) => operators[lane])).toEqual(
      LANES.map(() => operator),
    );
  });

  it("accepts a complete set of per-lane operators", () => {
    const values = Object.fromEntries(
      LANES.map((lane) => [
        `op-${lane}`,
        DEFAULT_SIGNER_MANAGERS[lane % DEFAULT_SIGNER_MANAGERS.length],
      ]),
    );
    const operators = resolveOperators(values);

    expect(LANES.map((lane) => operators[lane])).toEqual(
      LANES.map(
        (lane) => DEFAULT_SIGNER_MANAGERS[lane % DEFAULT_SIGNER_MANAGERS.length],
      ),
    );
  });

  it("rejects mixed operator modes", () => {
    expect(() =>
      resolveOperators({ "op-all": operator, "op-0": operator }),
    ).toThrow(/either --op-all/);
  });

  it("rejects incomplete per-lane operators", () => {
    expect(() => resolveOperators({ "op-0": operator })).toThrow(
      /Missing: --op-1, --op-2, --op-3, --op-4, --op-5/,
    );
  });

  it("parses a positive per-transaction fee", () => {
    expect(parseFeeUstx("12345")).toBe(12345n);
    expect(parseFeeUstx(undefined)).toBeUndefined();
    expect(() => parseFeeUstx("0")).toThrow(/greater than zero/);
    expect(() => parseFeeUstx("1.5")).toThrow(/positive integer/);
  });

  it("captures a plain-text broadcast rejection without consuming it", async () => {
    const response = new Response("Failed to decode transaction", {
      status: 400,
      statusText: "Bad Request",
      headers: {
        "content-type": "text/plain; charset=UTF-8",
        "cf-ray": "request-id",
      },
    });

    const details = await captureBroadcastHttpResponse(
      "https://api.hiro.so/v2/transactions",
      { method: "POST" },
      response,
    );

    expect(details).toMatchObject({
      url: "https://api.hiro.so/v2/transactions",
      method: "POST",
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: {
        "content-type": "text/plain; charset=UTF-8",
        "cf-ray": "request-id",
      },
      body: "Failed to decode transaction",
      bodyTruncated: false,
    });
    expect(await response.text()).toBe("Failed to decode transaction");
  });

  it("truncates an unexpectedly large broadcast response", async () => {
    const response = new Response("x".repeat(16_385), { status: 502 });
    const details = await captureBroadcastHttpResponse(
      "https://api.hiro.so/v2/transactions",
      { method: "POST" },
      response,
    );

    expect(details.body).toHaveLength(16_384);
    expect(details.bodyTruncated).toBe(true);
  });
});
