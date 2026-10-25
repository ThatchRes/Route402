// Compliance controls: sanctions name screening, partner-of-record, Travel Rule completeness, KYB records, monitoring
// alerts and the ISO 20022 structured address. Isolated: temp working directory, no network, no payments.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "route402-compliance-")); process.chdir(dir);
delete process.env.OPENSANCTIONS_API_KEY; delete process.env.CHAINALYSIS_API_KEY; delete process.env.SANCTIONS_LIST_PATH;
const { complianceChecks, normName, screenName, travelRuleRecord, travelRuleGaps, cleanCompliance } = await import("./router/compliance.js");
const { recordKyb, kybVerified } = await import("./company/kyb.js");
const { monitorRequest } = await import("./company/monitoring.js");
const { pain001 } = await import("./company/iso20022.js");
const C = await import("./company/controls.js");
let n = 0; const pass = (m: string) => console.log(`PASS ${++n}: ${m}`);
const policy = (c: any = {}) => ({ ...C.loadPolicy(), compliance: cleanCompliance(c) });
const coin = { routeKind: "stablecoin" as const, coins: ["EURC"], destCcy: "EUR", country: "DE", amountUsd: 5000, routeIds: ["coin:USDC>EURC:base:eurc_redeem"] };
const now = new Date("2026-10-24T12:00:00Z");

// Names normalise across case, accents, punctuation and legal-form words
assert.equal(normName("Société Générale, S.A."), "SOCIETE GENERALE"); assert.equal(normName("ACME Trading Co., Ltd."), "ACME TRADING");
pass("names normalise for comparison");

// No list and no service: a warning by default, a hold when policy requires screening
let r = await complianceChecks({ ...coin, supplierName: "Hamburg Werkzeug GmbH" }, policy(), now);
assert.equal(r.checks.find((c) => c.id === "sanctions_name")?.status, "warn"); assert.equal(r.ok, true);
r = await complianceChecks({ ...coin, supplierName: "Hamburg Werkzeug GmbH" }, policy({ requireNameScreening: true }), now);
assert.equal(r.checks.find((c) => c.id === "sanctions_name")?.status, "fail"); assert.equal(r.ok, false);
pass("unscreened names warn by default and are held when screening is required");

// OFAC SDN.CSV and ALT.CSV formats: an exact or near match blocks, an unrelated name passes
writeFileSync("SDN.CSV", '36,"AEROCARIBBEAN AIRLINES","-0-","CUBA","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"\n173,"ANGLO-CARIBBEAN CO., LTD.","-0-","CUBA","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"\n');
writeFileSync("ALT.CSV", '36,12,"aka","AERO-CARIBBEAN","-0-"\n');
process.env.SANCTIONS_LIST_PATH = `${dir}/SDN.CSV,${dir}/ALT.CSV`;
assert.equal((await screenName("Anglo Caribbean Company Limited"))?.hit, true);
assert.equal((await screenName("Aero Caribbean"))?.hit, true);
assert.equal((await screenName("Hamburg Werkzeug GmbH"))?.hit, false);
r = await complianceChecks({ ...coin, routeKind: "bank_wire", coins: [], supplierName: "Anglo-Caribbean Co Ltd" }, policy(), now);
assert.equal(r.ok, false); assert.match(r.reason ?? "", /possible match/);
pass("listed names (primary and alias) block on every rail; unrelated names pass");
delete process.env.SANCTIONS_LIST_PATH;

// Partner of record for each stablecoin off-ramp
r = await complianceChecks(coin, policy(), now);
assert.equal(r.checks.find((c) => c.id === "payout_partner")?.status, "warn");
r = await complianceChecks(coin, policy({ requirePartnerAgreements: true }), now); assert.equal(r.ok, false);
r = await complianceChecks(coin, policy({ requirePartnerAgreements: true, partnerAgreements: { eurc_redeem: "Circle Mint, MSA 2026-001" } }), now);
assert.equal(r.checks.find((c) => c.id === "payout_partner")?.status, "pass"); assert.equal(r.ok, true);
pass("off-ramps need a recorded partner agreement when policy requires one");

// Travel Rule: the record lists missing addresses until KYB and supplier addresses exist
const bare = travelRuleRecord({ name: "Northbridge" }, "Operating account", { name: "Hamburg Werkzeug", country: "DE", iban: "DE89370400440532013000" }, "5000.00 USD", "USDC>EURC");
assert.equal(travelRuleGaps(bare).length, 2);
r = await complianceChecks({ ...coin, travelRule: bare }, policy(), now); assert.equal(r.checks.find((c) => c.id === "travel_rule")?.status, "warn");
const full = travelRuleRecord({ name: "Northbridge Manufacturing Corp.", country: "US", registrationNumber: "12-3456789", address: { street: "1 Main St", city: "Atlanta", postcode: "30303" } },
  "Operating account", { name: "Hamburg Werkzeug", country: "DE", street: "Hafenstr. 1", city: "Hamburg", postcode: "20457" }, "5000.00 USD", "USDC>EURC");
assert.deepEqual(travelRuleGaps(full), []); assert.equal(full.originator.address?.country, "US");
pass("Travel Rule record is complete only with originator and beneficiary addresses");

// KYB: a verified result needs registration, address, beneficial owners and a date
const base = { status: "verified", provider: "Partner Bank", caseRef: "KYB-1", legalName: "Northbridge Manufacturing Corp.", country: "US" };
assert.throws(() => recordKyb("co", base, "priya"), /registration number/);
assert.throws(() => recordKyb("co", { ...base, registrationNumber: "12-3456789", street: "1 Main St", city: "Atlanta" }, "priya"), /beneficial owners/);
recordKyb("co", { ...base, registrationNumber: "12-3456789", street: "1 Main St", city: "Atlanta", beneficialOwnersVerified: true, verifiedAt: "2026-10-01" }, "priya");
assert.equal(kybVerified("co"), true); assert.equal(kybVerified("other"), false);
pass("KYB results are recorded only with the partner's full verification");

// Monitoring: new payee (info), changed details, velocity and just-under-threshold (review)
const req = (o: any) => ({ id: "pr_x", payable: "b", supplier: "Hamburg Werkzeug", country: "DE", ccy: "EUR", amount: "1", reference: "b", intentId: "i", provider: "stablecoin",
  route: "coin:USDC>EURC:base:eurc_redeem", debitUsd: 1000, recipientGets: "1 EUR", arrivalUtc: "", agentReasons: [], preparedBy: "maya", preparedAt: now.toISOString(),
  detailsChanged: false, approvals: [], releaseOnDelivery: false, status: "AWAITING_APPROVAL", ...o }) as any;
let a = monitorRequest(req({}), [], policy(), C.USERS, now.getTime());
assert.deepEqual(a.map((x) => [x.rule, x.severity]), [["new_payee", "info"]]);
const prior = [req({ id: "pr_1" }), req({ id: "pr_2" })];
a = monitorRequest(req({ debitUsd: 2900, detailsChanged: true }), prior, policy(), C.USERS, now.getTime());
assert.deepEqual(a.map((x) => x.rule).sort(), ["details_changed", "near_threshold", "velocity"]);
assert.ok(a.every((x) => x.severity === "review"));
a = monitorRequest(req({ debitUsd: 240_000, route: "bank:wire" }), prior, policy(), C.USERS, now.getTime());
assert.ok(a.some((x) => x.rule === "near_threshold" && /approver limit/.test(x.detail)));
pass("monitoring flags new payees, changed details, velocity and structuring patterns");

// ISO 20022: structured creditor and debtor addresses in schema order
const xml = pain001({ msgId: "m", createdAt: now.toISOString(), debtorName: "Northbridge", debtorAccountRef: "ACCT", executionDate: now.toISOString(), endToEndId: "e",
  amount: "10.00", ccy: "EUR", invoiceRef: "INV", debtorAddress: { street: "1 Main St", city: "Atlanta", postcode: "30303", country: "US" },
  beneficiary: { id: "s", name: "Hamburg Werkzeug", country: "DE", currency: "EUR", iban: "DE89370400440532013000", street: "Hafenstr. 1", city: "Hamburg", postcode: "20457" } });
assert.match(xml, /<Cdtr><Nm>Hamburg Werkzeug<\/Nm><PstlAdr><StrtNm>Hafenstr. 1<\/StrtNm><PstCd>20457<\/PstCd><TwnNm>Hamburg<\/TwnNm><Ctry>DE<\/Ctry><\/PstlAdr><\/Cdtr>/);
assert.match(xml, /<Dbtr><Nm>Northbridge<\/Nm><PstlAdr><StrtNm>1 Main St<\/StrtNm><PstCd>30303<\/PstCd><TwnNm>Atlanta<\/TwnNm><Ctry>US<\/Ctry><\/PstlAdr><\/Dbtr>/);
pass("pain.001 carries structured debtor and creditor addresses");
console.log(`\n${n} compliance checks passed`);
