// Unit tests for the NearGuard policy engine (src/policy.ts).
// Run: npm test   (node --test test/)
// All amounts are yoctoNEAR decimal strings, as on-chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAction, dayIndex } from "../src/policy.ts";

const Y = 10n ** 24n; // 1 NEAR in yocto
const near = (whole, frac = 0n) => (BigInt(whole) * Y + frac).toString();
const tenth = (n) => ((Y / 10n) * BigInt(n)).toString(); // n * 0.1 NEAR

const basePolicy = () => ({
  dailyLimit: near(5),
  perTxCap: near(2),
  warnBps: 8000, // warn at 80% of a limit
  frozen: false,
  allowlist: [],
  blocklist: ["known-scam.testnet"],
  allowedMethods: ["transfer", "ft_transfer"],
});

const pay = (counterparty, amount, method = "transfer") => ({
  counterparty,
  amount,
  method,
});

test("clean action is allowed", () => {
  const ev = evaluateAction(basePolicy(), pay("helper.testnet", tenth(5)), "0");
  assert.equal(ev.verdict, "allow");
  assert.equal(ev.reason, "all checks passed");
});

test("amount exactly at the per-tx cap is not blocked", () => {
  const ev = evaluateAction(basePolicy(), pay("helper.testnet", near(2)), "0");
  assert.notEqual(ev.verdict, "block");
  const cap = ev.checks.find((c) => c.name === "per-tx-cap");
  assert.equal(cap.verdict, "warn"); // 100% of cap sits in the warn zone
});

test("amount over the per-tx cap is blocked", () => {
  const ev = evaluateAction(basePolicy(), pay("helper.testnet", near(3)), "0");
  assert.equal(ev.verdict, "block");
  assert.match(ev.reason, /per-transaction cap/);
});

test("cumulative spend over the daily limit is blocked", () => {
  // 4.5 NEAR already spent today; one more 1 NEAR breaches the 5 NEAR day cap.
  const ev = evaluateAction(
    basePolicy(),
    pay("helper.testnet", near(1)),
    tenth(45),
  );
  assert.equal(ev.verdict, "block");
  assert.match(ev.reason, /daily limit/);
});

test("spend landing exactly on the daily limit is not blocked", () => {
  const ev = evaluateAction(
    basePolicy(),
    pay("helper.testnet", near(1)),
    near(4),
  );
  assert.notEqual(ev.verdict, "block");
});

test("blocklisted counterparty is blocked even for a tiny amount", () => {
  const ev = evaluateAction(
    basePolicy(),
    pay("known-scam.testnet", tenth(1)),
    "0",
  );
  assert.equal(ev.verdict, "block");
  assert.match(ev.reason, /blocklist/);
});

test("frozen guard blocks an otherwise clean action", () => {
  const p = basePolicy();
  p.frozen = true;
  const ev = evaluateAction(p, pay("helper.testnet", tenth(1)), "0");
  assert.equal(ev.verdict, "block");
  assert.match(ev.reason, /frozen/);
});

test("counterparty missing from a non-empty allowlist warns (human must confirm)", () => {
  const p = basePolicy();
  p.allowlist = ["helper.testnet"];
  const ev = evaluateAction(p, pay("stranger.testnet", tenth(1)), "0");
  assert.equal(ev.verdict, "warn");
  assert.match(ev.reason, /not on the allowlist/);
});

test("allowlisted counterparty is allowed", () => {
  const p = basePolicy();
  p.allowlist = ["helper.testnet"];
  const ev = evaluateAction(p, pay("helper.testnet", tenth(1)), "0");
  assert.equal(ev.verdict, "allow");
});

test("unlisted method warns", () => {
  const ev = evaluateAction(
    basePolicy(),
    pay("helper.testnet", tenth(1), "panic_the_agent"),
    "0",
  );
  assert.equal(ev.verdict, "warn");
  assert.match(ev.reason, /allowed-method list/);
});

test("large single action inside the caps warns (per-tx warn zone)", () => {
  // 1.7 NEAR is 85% of the 2 NEAR per-tx cap, well inside the 5 NEAR day cap.
  const ev = evaluateAction(basePolicy(), pay("helper.testnet", tenth(17)), "0");
  assert.equal(ev.verdict, "warn");
  assert.match(ev.reason, /per-transaction cap/);
});

test("spend reaching the daily warn zone warns", () => {
  // 3.5 spent + 0.6 = 4.1 of 5 NEAR = 82% of the daily limit.
  const ev = evaluateAction(
    basePolicy(),
    pay("helper.testnet", tenth(6)),
    tenth(35),
  );
  assert.equal(ev.verdict, "warn");
  assert.match(ev.reason, /daily limit/);
});

test("zero amount is blocked", () => {
  const ev = evaluateAction(basePolicy(), pay("helper.testnet", "0"), "0");
  assert.equal(ev.verdict, "block");
});

test("unparseable amount is blocked", () => {
  const ev = evaluateAction(basePolicy(), pay("helper.testnet", "abc"), "0");
  assert.equal(ev.verdict, "block");
});

test("worst verdict wins and all blocking reasons are reported", () => {
  // Blocklisted AND over the per-tx cap: one verdict (block), both reasons.
  const ev = evaluateAction(basePolicy(), pay("known-scam.testnet", near(3)), "0");
  assert.equal(ev.verdict, "block");
  assert.match(ev.reason, /blocklist/);
  assert.match(ev.reason, /per-transaction cap/);
});

test("dayIndex buckets timestamps by UTC day", () => {
  assert.equal(dayIndex(0n), "0");
  assert.equal(dayIndex(86399999999999n), "0");
  assert.equal(dayIndex(86400000000000n), "1");
  const t0 = 1762224000000000000n; // 2025-11-04T00:00:00Z in ns
  assert.equal(dayIndex(t0), dayIndex(t0 + 3600000000000n)); // +1h, same day
  assert.notEqual(dayIndex(t0), dayIndex(t0 + 25n * 3600000000000n)); // +25h
});
