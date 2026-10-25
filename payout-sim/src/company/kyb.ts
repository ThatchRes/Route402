// Company verification (KYB). Route402 does not verify companies itself: the licensed partner of record runs KYB (legal
// entity, registration, beneficial owners, authorized signers) and Route402 records the partner's result and case number.
// With `requireKyb` on in Policy & people, no payment request can be prepared until a verified result is recorded.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Address } from "../router/compliance.js";

export interface KybRecord {
  companyId: string; status: "verified" | "pending" | "rejected"; provider: string; caseRef: string;
  legalName: string; registrationNumber: string; country: string; address: Address;
  beneficialOwnersVerified: boolean; verifiedAt: string; recordedBy: string; recordedAt: string;
}
const FILE = "data/kyb.json";
const all = (): Record<string, KybRecord> => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
export const kybFor = (companyId: string): KybRecord | null => all()[companyId] ?? null;
export const kybVerified = (companyId: string) => kybFor(companyId)?.status === "verified";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export function recordKyb(companyId: string, body: any, actor: string): KybRecord {
  const status = ["verified", "pending", "rejected"].includes(body?.status) ? body.status : null;
  const r: KybRecord = { companyId, status: status ?? "pending", provider: text(body?.provider, 80), caseRef: text(body?.caseRef, 80),
    legalName: text(body?.legalName, 120), registrationNumber: text(body?.registrationNumber, 60), country: text(body?.country, 2).toUpperCase(),
    address: { street: text(body?.street, 120) || undefined, city: text(body?.city, 80) || undefined, postcode: text(body?.postcode, 20) || undefined },
    beneficialOwnersVerified: body?.beneficialOwnersVerified === true, verifiedAt: text(body?.verifiedAt, 10),
    recordedBy: actor, recordedAt: new Date().toISOString() };
  if (!status) throw new Error("Choose the partner's KYB result: verified, pending or rejected");
  if (!r.provider || !r.caseRef) throw new Error("Enter the KYB partner and its case reference");
  if (!r.legalName || !/^[A-Z]{2}$/.test(r.country)) throw new Error("Enter the legal name and two-letter country of registration");
  if (r.status === "verified") {
    if (!r.registrationNumber || !r.address.street || !r.address.city) throw new Error("A verified result needs the registration number and registered address");
    if (!r.beneficialOwnersVerified) throw new Error("A verified result needs the beneficial owners verified by the partner");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.verifiedAt)) throw new Error("Enter the date the partner verified the company");
  }
  const m = all(); m[companyId] = r; mkdirSync("data", { recursive: true }); writeFileSync(FILE, JSON.stringify(m, null, 2)); return r;
}
