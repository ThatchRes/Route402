// Chat authority storage regression checks: isolated files, no network or payments.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as S from "./assistant/asiState.js";

const cwd = process.cwd(), directory = mkdtempSync(path.join(tmpdir(), "route402-asi-state-"));
const actualNow = Date.now; let now = 2_000_000_000_000;
Date.now = () => now;
process.chdir(directory);
const scope = ["demo-tenant", "agent_signed_sender", "chat-session-one", "company-one"] as const;
const cookie = `r402=${"a".repeat(48)}`, sessionHash = S.sessionFingerprint(cookie)!;
const valid = (hash: string, user: string) => hash === sessionHash && user === "alex";
let checks = 0;
const pass = (message: string) => console.log(`PASS ${++checks}: ${message}`);
const pending = (id = "confirm-one"): S.AsiPending => ({ id, state: "ready", conversationId: "fetch_conversation", conversationRevision: 2,
  plans: [{ intentId: "int_one", payable: "invoice-one", termsHash: "displayed-terms-hash", expiresAt: now + 60_000 }],
  details: [{ supplier: "Fixture", youPay: "500.00 USD" }], expiresAt: now + 60_000 });
try {
  assert.equal(S.sessionFingerprint(undefined), undefined);
  assert.equal(S.sessionFingerprint("other=aaa"), undefined);
  assert.equal(S.sessionFingerprint("r402=not-a-token"), undefined);
  assert.equal(S.sessionFingerprint(`other=x; ${cookie}; another=y`), sessionHash);
  assert.equal(sessionHash, createHash("sha256").update("a".repeat(48)).digest("hex"));
  pass("session fingerprints match the existing hashed-session store without exposing cookies");

  assert.throws(() => S.requireBinding(...scope, valid), /Connect this chat/);
  const link = S.beginLink(...scope);
  assert.match(link.token, /^[a-f0-9]{64}$/); assert.equal(link.expiresAt, now + 300_000);
  assert.ok(!readFileSync("data/asi-chat.json", "utf8").includes(link.token));
  assert.ok(!readFileSync("data/asi-chat.json", "utf8").includes(cookie));
  pass("new links use 256-bit challenges and persist only their hashes");

  assert.throws(() => S.completeLink(link.token, "alex", sessionHash, "another-company"), /invalid or expired/);
  const binding = S.completeLink(link.token, "alex", sessionHash, scope[3]);
  assert.equal(binding.userId, "alex"); assert.equal(binding.companyId, scope[3]);
  assert.deepEqual(S.requireBinding(...scope, valid), binding);
  assert.throws(() => S.completeLink(link.token, "alex", sessionHash, scope[3]), /invalid or expired/);
  pass("browser linking checks the current company and consumes a challenge only once");

  for (let index = 0; index < scope.length; index++) {
    const other: [string, string, string, string] = [...scope]; other[index] += "-different";
    assert.throws(() => S.requireBinding(...other, valid), /Connect this chat/);
  }
  pass("authority is isolated by tenant, signed sender, session and company");

  S.setPending(binding, pending());
  const detached = S.getPending(binding)!; detached.details[0].youPay = "9000 USD";
  assert.equal(S.getPending(binding)!.details[0].youPay, "500.00 USD");
  S.updatePending(binding, { state: "processing", requestIds: ["pr_one"] });
  assert.equal(S.getPending(binding)!.state, "processing");
  assert.throws(() => S.updatePending(binding, { id: "different-confirmation" }), /confirmation changed/);
  S.updatePending(binding, { state: "done", result: { status: "EXECUTING" } });
  const restartedModule = "./assistant/asiState.js?restart=1";
  const afterRestart = await import(restartedModule);
  assert.deepEqual(afterRestart.requireBinding(...scope, valid), binding);
  assert.deepEqual(afterRestart.getPending(binding)?.result, { status: "EXECUTING" });
  pass("pending work and results persist across module restarts, with detached reads and fixed confirmation identity");

  S.clearPending(binding); assert.equal(S.getPending(binding), undefined);
  assert.throws(() => S.updatePending(binding, { state: "processing" }), /no current payment/);
  assert.throws(() => S.setPending(binding, { ...pending(), expiresAt: NaN }), /Invalid chat confirmation/);
  assert.throws(() => S.setPending(binding, { ...pending(), conversationRevision: -1 }), /Invalid chat confirmation/);
  assert.throws(() => S.setPending(binding, { ...pending(), details: ["x".repeat(200_001)] }), /too large/);
  pass("pending state rejects malformed or oversized records and supports deliberate clearing");

  const replacement = S.beginLink(...scope), latest = S.beginLink(...scope);
  assert.throws(() => S.completeLink(replacement.token, "alex", sessionHash, scope[3]), /invalid or expired/);
  const newBinding = S.completeLink(latest.token, "alex", sessionHash, scope[3]);
  assert.notEqual(newBinding.id, binding.id);
  assert.throws(() => S.setPending(binding, pending()), /Connect this chat/);
  assert.throws(() => S.getPending(binding), /Connect this chat/);
  assert.equal(S.getPending(newBinding), undefined);
  pass("new challenges supersede old ones and relinking replaces the exact authority version");

  S.setPending(newBinding, pending());
  assert.throws(() => S.requireBinding(...scope, () => false), /Connect this chat/);
  assert.throws(() => S.requireBinding(...scope, valid), /Connect this chat/);
  assert.throws(() => S.getPending(newBinding), /Connect this chat/);
  pass("session revocation invalidates linked authority and its pending payment");

  const expired = S.beginLink(...scope); now += 300_001;
  assert.throws(() => S.completeLink(expired.token, "alex", sessionHash, scope[3]), /invalid or expired/);
  const fresh = S.beginLink(...scope), expiringBinding = S.completeLink(fresh.token, "alex", sessionHash, scope[3]);
  S.setPending(expiringBinding, pending()); now = expiringBinding.expiresAt;
  assert.throws(() => S.requireBinding(...scope, valid), /Connect this chat/);
  pass("challenge and authority expiration are enforced at their exact boundary");

  const revocable = S.beginLink(...scope), revocableBinding = S.completeLink(revocable.token, "alex", sessionHash, scope[3]);
  S.setPending(revocableBinding, pending()); S.revokeBinding(...scope);
  assert.throws(() => S.requireBinding(...scope, valid), /Connect this chat/);
  const unconsumed = S.beginLink(...scope); S.revokeBinding(...scope);
  assert.throws(() => S.completeLink(unconsumed.token, "alex", sessionHash, scope[3]), /invalid or expired/);
  pass("explicit disconnection removes both active authority and unconsumed connection challenges");

  writeFileSync("data/asi-chat.json", "invalid json");
  assert.throws(() => S.beginLink(...scope), /authorization is unavailable/);
  assert.throws(() => S.requireBinding(...scope, valid), /authorization is unavailable/);
  assert.throws(() => S.completeLink("x", "alex", sessionHash, scope[3]), /invalid or expired/);
  pass("corrupt authorization storage fails closed with a safe user-facing error");
  console.log(`ASI state suite: ${checks} checks passed; isolated files, no payments or external calls.`);
} finally {
  Date.now = actualNow; process.chdir(cwd);
}
