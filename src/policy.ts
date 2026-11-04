// NearGuard policy engine (pure logic, no NEAR imports).
//
// This module is the heart of the guard. It is deliberately free of any
// near-sdk-js dependency so it can be unit-tested in plain Node
// (test/policy.test.mjs) and run in the local demo (demo/demo.mjs).
// src/contract.ts is a thin on-chain wrapper around evaluateAction().
//
// Verdict semantics are ported from tgp-guard (Telegraph pre-flight guard):
//   - guard.mjs:    ALLOW when sources agree, HOLD when a check cannot
//                   clear, BLOCK when listed or way off-market.
//   - screen.mjs:   sanctions/blocklist hit -> BLOCK; a check that cannot
//                   be completed -> HOLD (fail closed, never silently pass).
//   - preflight.mjs: the overall verdict is the WORST of the sub-checks
//                   (BLOCK > HOLD > ALLOW). evaluateAction() does the same.
// The track's vocabulary is allow / warn / block, so HOLD is named "warn":
// warn means "a human must approve before this proceeds".
//
// Limit semantics come from Aegis (spend control for AI agents on Base):
// a hard per-transaction cap, a hard daily cap, and an owner freeze that
// refuses everything. Amounts are yoctoNEAR as decimal strings (BigInt
// math only, no floats anywhere near money).

export type Verdict = "allow" | "warn" | "block";

export interface GuardPolicy {
  /** Max total spend per day, yoctoNEAR decimal string. */
  dailyLimit: string;
  /** Max amount for a single action, yoctoNEAR decimal string. */
  perTxCap: string;
  /** Warn when a check reaches this share of its limit, in basis points (8000 = 80%). */
  warnBps: number;
  /** When true, every action is blocked. Owner-controlled kill switch. */
  frozen: boolean;
  /** If non-empty, counterparties NOT on this list produce a warn (human must confirm). */
  allowlist: string[];
  /** Any counterparty on this list is blocked outright (known-bad / sanctions-style list). */
  blocklist: string[];
  /** If non-empty, methods NOT on this list produce a warn. */
  allowedMethods: string[];
}

export interface GuardAction {
  counterparty: string;
  /** Amount in yoctoNEAR, decimal string. */
  amount: string;
  /** The function/method the agent wants to invoke, e.g. "ft_transfer". */
  method: string;
}

export interface CheckResult {
  name: string;
  verdict: Verdict;
  reason: string;
}

export interface Evaluation {
  verdict: Verdict;
  reason: string;
  checks: CheckResult[];
}

const RANK: Record<Verdict, number> = { allow: 0, warn: 1, block: 2 };
const NANOS_PER_DAY = 86400000000000n;

/** Day bucket for a NEAR block timestamp (nanoseconds since epoch). */
export function dayIndex(timestampNs: bigint): string {
  return (timestampNs / NANOS_PER_DAY).toString();
}

function parseAmount(amount: string): bigint | null {
  try {
    if (!/^\d+$/.test(amount)) return null;
    return BigInt(amount);
  } catch {
    return null;
  }
}

function pctOf(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0";
  return ((part * 10000n) / whole / 100n).toString();
}

/**
 * Evaluate one proposed agent action against the policy.
 *
 * @param policy     The owner-set guard policy.
 * @param action     Counterparty, amount (yoctoNEAR string), method.
 * @param spentToday YoctoNEAR already spent in the current day bucket.
 * @returns Worst-wins verdict across all sub-checks, with per-check detail.
 */
export function evaluateAction(
  policy: GuardPolicy,
  action: GuardAction,
  spentToday: string,
): Evaluation {
  const checks: CheckResult[] = [];
  const amount = parseAmount(action.amount);
  const spent = parseAmount(spentToday) ?? 0n;
  const dailyLimit = parseAmount(policy.dailyLimit) ?? 0n;
  const perTxCap = parseAmount(policy.perTxCap) ?? 0n;
  const warnBps = BigInt(Math.trunc(policy.warnBps));

  // 1. Freeze: Aegis semantics - a frozen guard refuses everything.
  checks.push(
    policy.frozen
      ? {
          name: "frozen",
          verdict: "block",
          reason: "guard is frozen by the owner; all agent actions are refused",
        }
      : { name: "frozen", verdict: "allow", reason: "guard is not frozen" },
  );

  // 2. Amount sanity: a non-positive or unparseable amount never proceeds.
  checks.push(
    amount === null || amount <= 0n
      ? {
          name: "amount",
          verdict: "block",
          reason: "amount must be a positive integer (yoctoNEAR)",
        }
      : { name: "amount", verdict: "allow", reason: "amount is well-formed" },
  );

  // 3. Blocklist: tgp-guard screen.mjs semantics - a list hit is a hard BLOCK.
  checks.push(
    policy.blocklist.includes(action.counterparty)
      ? {
          name: "blocklist",
          verdict: "block",
          reason: `counterparty ${action.counterparty} is on the blocklist (known-bad)`,
        }
      : {
          name: "blocklist",
          verdict: "allow",
          reason: "counterparty is not on the blocklist",
        },
  );

  // 4. Per-transaction cap: Aegis hard cap, with a warn zone below it.
  if (amount !== null && amount > 0n) {
    if (amount > perTxCap) {
      checks.push({
        name: "per-tx-cap",
        verdict: "block",
        reason: `amount ${action.amount} exceeds the per-transaction cap ${policy.perTxCap}`,
      });
    } else if (perTxCap > 0n && amount * 10000n >= perTxCap * warnBps) {
      checks.push({
        name: "per-tx-cap",
        verdict: "warn",
        reason: `single action is at ${pctOf(amount, perTxCap)}% of the per-transaction cap`,
      });
    } else {
      checks.push({
        name: "per-tx-cap",
        verdict: "allow",
        reason: "amount is within the per-transaction cap",
      });
    }
  }

  // 5. Daily limit: Aegis hard daily cap over the running day total.
  if (amount !== null && amount > 0n) {
    const projected = spent + amount;
    if (projected > dailyLimit) {
      checks.push({
        name: "daily-limit",
        verdict: "block",
        reason: `spending ${action.amount} would take today's total to ${projected.toString()}, over the daily limit ${policy.dailyLimit} (already spent ${spentToday})`,
      });
    } else if (dailyLimit > 0n && projected * 10000n >= dailyLimit * warnBps) {
      checks.push({
        name: "daily-limit",
        verdict: "warn",
        reason: `this action takes today's spend to ${pctOf(projected, dailyLimit)}% of the daily limit`,
      });
    } else {
      checks.push({
        name: "daily-limit",
        verdict: "allow",
        reason: "amount is within the daily limit",
      });
    }
  }

  // 6. Allowlist: fail-closed warn, mirroring screen.mjs "cannot clear -> HOLD".
  if (policy.allowlist.length > 0) {
    checks.push(
      policy.allowlist.includes(action.counterparty)
        ? {
            name: "allowlist",
            verdict: "allow",
            reason: "counterparty is on the allowlist",
          }
        : {
            name: "allowlist",
            verdict: "warn",
            reason: `counterparty ${action.counterparty} is not on the allowlist; a human must confirm`,
          },
    );
  } else {
    checks.push({
      name: "allowlist",
      verdict: "allow",
      reason: "allowlist not enforced (empty)",
    });
  }

  // 7. Method scope: the on-chain version of a function-call access key's
  //    method whitelist. Unknown methods warn instead of passing silently.
  if (policy.allowedMethods.length > 0) {
    checks.push(
      policy.allowedMethods.includes(action.method)
        ? {
            name: "method",
            verdict: "allow",
            reason: `method ${action.method} is in the allowed-method list`,
          }
        : {
            name: "method",
            verdict: "warn",
            reason: `method ${action.method} is not in the owner's allowed-method list; a human must confirm`,
          },
    );
  } else {
    checks.push({
      name: "method",
      verdict: "allow",
      reason: "method list not enforced (empty)",
    });
  }

  // Worst-wins aggregation, exactly like tgp-guard's preflight.mjs.
  let verdict: Verdict = "allow";
  for (const c of checks) {
    if (RANK[c.verdict] > RANK[verdict]) verdict = c.verdict;
  }
  const reason =
    verdict === "allow"
      ? "all checks passed"
      : checks
          .filter((c) => c.verdict === verdict)
          .map((c) => c.reason)
          .join("; ");
  return { verdict, reason, checks };
}
