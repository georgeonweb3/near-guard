// NearGuard contract (NEAR testnet) - thin on-chain wrapper around the
// policy engine in ./policy.ts. All verdict logic lives in policy.ts and is
// unit-tested off-chain (test/policy.test.mjs); this file only adds state,
// owner gates, and the execute/approve flow.
//
// How an agent uses it (the track's pattern):
//   1. The agent's wallet holds ONLY a function-call access key scoped to
//      this contract's `execute` and `check` methods, with a small NEAR
//      allowance. The key cannot call the owner methods even if the agent
//      is fully prompt-injected, and the owner methods also check that the
//      caller is the owner account.
//   2. Before paying anyone, the agent calls `execute`. On "block" the call
//      panics, so the guarded action cannot proceed through the guard at
//      all. On "warn" the action is parked as a pending request and only
//      the owner can `approve` it. On "allow" the spend is recorded against
//      today's limit and returned as authorised.
//
// Note: `execute` is the authorisation gate, not a custody wallet. The
// agent performs its payment only after an "allowed"/"executed" result,
// exactly like tgp-guard's preflight gate works off-chain today.

import {
  NearBindgen,
  near,
  call,
  view,
  initialize,
  LookupMap,
  Vector,
} from "near-sdk-js";
import { evaluateAction, dayIndex } from "./policy";
import type { GuardPolicy, Evaluation } from "./policy";

interface PendingRequest {
  counterparty: string;
  amount: string;
  method: string;
  reason: string;
  status: "pending" | "executed" | "rejected";
  requestedBy: string;
}

@NearBindgen({ requireInit: true })
class NearGuard {
  owner: string;
  dailyLimit: string;
  perTxCap: string;
  warnBps: number;
  frozen: boolean;
  allowlist: string[];
  blocklist: string[];
  allowedMethods: string[];
  spentByDay: LookupMap<string>;
  requests: LookupMap<string>;
  nextRequestId: number;
  log: Vector<string>;

  constructor() {
    this.owner = "";
    this.dailyLimit = "0";
    this.perTxCap = "0";
    this.warnBps = 8000;
    this.frozen = false;
    this.allowlist = [];
    this.blocklist = [];
    this.allowedMethods = [];
    this.spentByDay = new LookupMap<string>("s");
    this.requests = new LookupMap<string>("r");
    this.nextRequestId = 0;
    this.log = new Vector<string>("l");
  }

  deserialize() {
    this.spentByDay = Object.assign(new LookupMap<string>("s"), this.spentByDay);
    this.requests = Object.assign(new LookupMap<string>("r"), this.requests);
    this.log = Object.assign(new Vector<string>("l"), this.log);
  }

  // ---------- setup ----------

  @initialize({})
  init({
    owner,
    daily_limit,
    per_tx_cap,
    warn_bps = 8000,
  }: {
    owner: string;
    daily_limit: string;
    per_tx_cap: string;
    warn_bps?: number;
  }) {
    this.owner = owner;
    this.dailyLimit = daily_limit;
    this.perTxCap = per_tx_cap;
    this.warnBps = warn_bps;
  }

  // ---------- internal helpers ----------

  policy(): GuardPolicy {
    return {
      dailyLimit: this.dailyLimit,
      perTxCap: this.perTxCap,
      warnBps: this.warnBps,
      frozen: this.frozen,
      allowlist: this.allowlist,
      blocklist: this.blocklist,
      allowedMethods: this.allowedMethods,
    };
  }

  assertOwner() {
    if (near.predecessorAccountId() !== this.owner) {
      throw new Error("only the guard owner can do this");
    }
  }

  todaySpent(): { day: string; spent: string } {
    const day = dayIndex(near.blockTimestamp());
    return { day, spent: this.spentByDay.get(day) ?? "0" };
  }

  recordSpend(day: string, spent: string, amount: string): string {
    const total = (BigInt(spent) + BigInt(amount)).toString();
    this.spentByDay.set(day, total);
    return total;
  }

  // ---------- views ----------

  @view({})
  get_policy(): GuardPolicy & { owner: string } {
    return { owner: this.owner, ...this.policy() };
  }

  @view({})
  check({
    counterparty,
    amount,
    method,
  }: {
    counterparty: string;
    amount: string;
    method: string;
  }): Evaluation {
    const { spent } = this.todaySpent();
    return evaluateAction(this.policy(), { counterparty, amount, method }, spent);
  }

  @view({})
  get_spent_today(): { day: string; spent: string } {
    return this.todaySpent();
  }

  @view({})
  get_request({ request_id }: { request_id: number }): PendingRequest | null {
    const raw = this.requests.get(String(request_id));
    return raw === null ? null : (JSON.parse(raw) as PendingRequest);
  }

  @view({})
  get_log({
    from_index = 0,
    limit = 20,
  }: {
    from_index?: number;
    limit?: number;
  }): string[] {
    const out: string[] = [];
    const end = Math.min(this.log.length, from_index + limit);
    for (let i = from_index; i < end; i++) {
      const entry = this.log.get(i);
      if (entry !== null) out.push(entry);
    }
    return out;
  }

  // ---------- owner policy controls ----------

  @call({})
  set_limits({
    daily_limit,
    per_tx_cap,
  }: {
    daily_limit: string;
    per_tx_cap: string;
  }) {
    this.assertOwner();
    this.dailyLimit = daily_limit;
    this.perTxCap = per_tx_cap;
    near.log(`policy: limits set to daily ${daily_limit}, per-tx ${per_tx_cap}`);
  }

  @call({})
  set_frozen({ frozen }: { frozen: boolean }) {
    this.assertOwner();
    this.frozen = frozen;
    near.log(`policy: frozen = ${frozen}`);
  }

  @call({})
  set_warn_bps({ warn_bps }: { warn_bps: number }) {
    this.assertOwner();
    this.warnBps = warn_bps;
  }

  @call({})
  allowlist_add({ account }: { account: string }) {
    this.assertOwner();
    if (!this.allowlist.includes(account)) this.allowlist.push(account);
  }

  @call({})
  allowlist_remove({ account }: { account: string }) {
    this.assertOwner();
    this.allowlist = this.allowlist.filter((a) => a !== account);
  }

  @call({})
  blocklist_add({ account }: { account: string }) {
    this.assertOwner();
    if (!this.blocklist.includes(account)) this.blocklist.push(account);
  }

  @call({})
  blocklist_remove({ account }: { account: string }) {
    this.assertOwner();
    this.blocklist = this.blocklist.filter((a) => a !== account);
  }

  @call({})
  set_allowed_methods({ methods }: { methods: string[] }) {
    this.assertOwner();
    this.allowedMethods = methods;
  }

  // ---------- the gate ----------

  @call({})
  execute({
    counterparty,
    amount,
    method,
  }: {
    counterparty: string;
    amount: string;
    method: string;
  }): { status: string; reason?: string; request_id?: number; spent_today?: string } {
    const { day, spent } = this.todaySpent();
    const ev = evaluateAction(
      this.policy(),
      { counterparty, amount, method },
      spent,
    );
    near.log(
      `guard check: pay ${counterparty} amount ${amount} via ${method} -> ${ev.verdict}: ${ev.reason}`,
    );
    if (ev.verdict === "block") {
      // Hard refusal: the transaction itself fails, so nothing the caller
      // chained on this result can proceed.
      throw new Error(`BLOCKED: ${ev.reason}`);
    }
    if (ev.verdict === "warn") {
      const id = this.nextRequestId++;
      const req: PendingRequest = {
        counterparty,
        amount,
        method,
        reason: ev.reason,
        status: "pending",
        requestedBy: near.predecessorAccountId(),
      };
      this.requests.set(String(id), JSON.stringify(req));
      return { status: "warn", request_id: id, reason: ev.reason };
    }
    const total = this.recordSpend(day, spent, amount);
    this.log.push(
      JSON.stringify({ day, counterparty, amount, method, verdict: "allow" }),
    );
    return { status: "allowed", spent_today: total };
  }

  @call({})
  approve({ request_id }: { request_id: number }): { status: string; spent_today?: string } {
    this.assertOwner();
    const raw = this.requests.get(String(request_id));
    if (raw === null) throw new Error(`no such request: ${request_id}`);
    const req = JSON.parse(raw) as PendingRequest;
    if (req.status !== "pending") {
      throw new Error(`request ${request_id} is already ${req.status}`);
    }
    // Re-check the hard limits at approval time: policy may have changed,
    // the guard may have been frozen, the day total may have moved.
    const { day, spent } = this.todaySpent();
    const ev = evaluateAction(
      this.policy(),
      { counterparty: req.counterparty, amount: req.amount, method: req.method },
      spent,
    );
    if (ev.verdict === "block") {
      throw new Error(`BLOCKED at approval: ${ev.reason}`);
    }
    const total = this.recordSpend(day, spent, req.amount);
    req.status = "executed";
    this.requests.set(String(request_id), JSON.stringify(req));
    this.log.push(
      JSON.stringify({
        day,
        counterparty: req.counterparty,
        amount: req.amount,
        method: req.method,
        verdict: "allow-after-warn",
      }),
    );
    near.log(`request ${request_id} approved and executed`);
    return { status: "executed", spent_today: total };
  }

  @call({})
  reject({ request_id }: { request_id: number }): { status: string } {
    this.assertOwner();
    const raw = this.requests.get(String(request_id));
    if (raw === null) throw new Error(`no such request: ${request_id}`);
    const req = JSON.parse(raw) as PendingRequest;
    if (req.status !== "pending") {
      throw new Error(`request ${request_id} is already ${req.status}`);
    }
    req.status = "rejected";
    this.requests.set(String(request_id), JSON.stringify(req));
    near.log(`request ${request_id} rejected by owner`);
    return { status: "rejected" };
  }
}
