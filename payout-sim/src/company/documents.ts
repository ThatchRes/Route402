// Programmable escrow in place of a letter of credit. A letter of credit has a bank pay once compliant shipping documents
// are presented; the bank takes up to five banking days to examine them (UCP 600, article 14(b)) and charges a fee for it.
// Here the same promise is a release condition: the money is approved and held (in escrow on the stablecoin rail, by
// Route402 before sending on bank rails) and is released the moment the documents verify, including an electronic bill of
// lading whose title has passed to the buyer. Electronic bills of lading carry title where the law recognises them
// (UNCITRAL MLETR; for example the UK Electronic Trade Documents Act 2023).
// eBL platforms need a commercial agreement for API access, so the verifier below runs against a simulated platform
// registry (data/ebl.json) with the same checks a live adapter performs; every result says it is simulated.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export type DocType = "ebl" | "commercial_invoice" | "inspection_certificate";
export interface DocumentaryTerms {
  latestShipmentUtc: string;      // goods must be shipped on board by this date
  presentationDays: number;       // documents must be presented within this many days of shipment (UCP 600 default 21)
  documents: DocType[];           // required documents; an eBL is always required
}
export const DOC_LABEL: Record<DocType, string> = { ebl: "Electronic bill of lading (title to the goods)", commercial_invoice: "Commercial invoice", inspection_certificate: "Inspection certificate" };
export const EBL_PLATFORMS = [
  { id: "wave_bl", label: "WAVE BL" }, { id: "essdocs", label: "essDOCS CargoDocs" }, { id: "bolero", label: "Bolero" },
  { id: "cargox", label: "CargoX" }, { id: "iqax", label: "IQAX eBL" },
];

export function cleanTerms(x: any, dueUtc?: string): DocumentaryTerms | { error: string } {
  const latest = Date.parse(x?.latestShipmentUtc ?? "");
  if (!Number.isFinite(latest)) return { error: "enter the latest shipment date" };
  const docs = new Set<DocType>(["ebl", "commercial_invoice", ...(Array.isArray(x?.documents) ? x.documents : []).filter((d: string) => d === "inspection_certificate")]);
  const days = Math.min(60, Math.max(1, Number(x?.presentationDays) || 21));
  if (dueUtc && latest > Date.parse(dueUtc)) return { error: "the latest shipment date must be on or before the payment deadline" };
  return { latestShipmentUtc: new Date(latest).toISOString(), presentationDays: days, documents: [...docs] };
}

// ------------------------------------------------------------------ simulated eBL platform registry
export interface EblRecord { ref: string; platform: string; carrier: string; shipper: string; holder: string; invoiceRef: string;
  goods: string; portOfLoading: string; portOfDischarge: string; shippedOnBoardUtc: string; issuedAt: string; simulated: true;
  inspectionRef?: string; history: { at: string; event: string }[] }
const FILE = "data/ebl.json";
const load = (): Record<string, EblRecord> => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
const save = (m: Record<string, EblRecord>) => { mkdirSync("data", { recursive: true }); writeFileSync(FILE, JSON.stringify(m, null, 2)); };

/** Demo only: the supplier's carrier issues an eBL and the supplier endorses title to the buyer, as a live platform would report it. */
export function simulateCarrierIssue(o: { supplier: string; buyer: string; invoiceRef: string; platform?: string; goods?: string; from?: string; to?: string; withInspection?: boolean }): EblRecord {
  const all = load(), now = new Date(), shipped = new Date(now.getTime() - 86400e3).toISOString();
  const rec: EblRecord = { ref: `EBL-${randomBytes(4).toString("hex").toUpperCase()}`, platform: o.platform ?? "wave_bl", carrier: "Demo Ocean Lines (simulated carrier)",
    shipper: o.supplier, holder: o.buyer, invoiceRef: o.invoiceRef, goods: o.goods ?? "Goods per commercial invoice", portOfLoading: o.from ?? "Port of loading", portOfDischarge: o.to ?? "Port of discharge",
    shippedOnBoardUtc: shipped, issuedAt: now.toISOString(), simulated: true, inspectionRef: o.withInspection ? `INSP-${randomBytes(3).toString("hex").toUpperCase()}` : undefined,
    history: [{ at: shipped, event: `issued to ${o.supplier} (shipper)` }, { at: now.toISOString(), event: `title endorsed to ${o.buyer} (buyer)` }] };
  all[rec.ref] = rec; save(all); return rec;
}

export interface DocCheck { id: string; label: string; ok: boolean; detail: string }
/** The checks a document examiner makes, each in plain words. All must pass to release. */
export function verifyDocuments(p: { eblRef: string; platform: string; invoiceRef: string; inspectionRef?: string }, expect: { supplier: string; buyer: string; invoiceRef: string; terms: DocumentaryTerms }, now = new Date()) {
  const rec = load()[String(p.eblRef).trim().toUpperCase()], t = expect.terms, checks: DocCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });
  const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  add("ebl_found", "eBL found on the platform", !!rec && rec.platform === p.platform, rec ? (rec.platform === p.platform ? `${rec.ref} on ${platformLabel(rec.platform)} (simulated platform)` : `${rec.ref} is registered on ${platformLabel(rec.platform)}, not ${platformLabel(p.platform)}`) : `no eBL ${p.eblRef} on ${platformLabel(p.platform)}`);
  if (rec) {
    add("title_holder", "Title has passed to you", norm(rec.holder) === norm(expect.buyer), `current holder: ${rec.holder}`);
    add("shipper", "Shipped by the supplier", norm(rec.shipper) === norm(expect.supplier), `shipper on the eBL: ${rec.shipper}`);
    add("shipped_in_time", "Shipped by the latest shipment date", Date.parse(rec.shippedOnBoardUtc) <= Date.parse(t.latestShipmentUtc),
      `shipped on board ${rec.shippedOnBoardUtc.slice(0, 10)}; latest allowed ${t.latestShipmentUtc.slice(0, 10)}`);
    const by = Date.parse(rec.shippedOnBoardUtc) + t.presentationDays * 86400e3;
    add("presented_in_time", "Presented within the presentation period", now.getTime() <= by, `presented ${now.toISOString().slice(0, 10)}; allowed until ${new Date(by).toISOString().slice(0, 10)} (${t.presentationDays} days after shipment)`);
    add("invoice_matches", "Commercial invoice matches", norm(p.invoiceRef) === norm(expect.invoiceRef) && norm(rec.invoiceRef) === norm(expect.invoiceRef),
      `invoice presented ${p.invoiceRef || "-"}; on the eBL ${rec.invoiceRef}; on the payment ${expect.invoiceRef}`);
    if (t.documents.includes("inspection_certificate"))
      add("inspection", "Inspection certificate", !!rec.inspectionRef && norm(p.inspectionRef ?? "") === norm(rec.inspectionRef), rec.inspectionRef ? `certificate ${p.inspectionRef || "not presented"}; carrier record ${rec.inspectionRef}` : "no inspection certificate recorded for this shipment");
  }
  return { ok: checks.length > 1 && checks.every((c) => c.ok), checks, ebl: rec ?? null, simulated: true };
}
export const platformLabel = (id: string) => EBL_PLATFORMS.find((x) => x.id === id)?.label ?? id;

/** What the same payment would cost and take under a letter of credit, from the company's own LC fee setting. */
export function lcComparison(debitUsd: number, lcFeePct: number) {
  return { lcFeeUsd: Math.round(debitUsd * lcFeePct) / 100, lcFeePct, examinationDays: 5,
    basis: `your bank's letter-of-credit fee setting (${lcFeePct}%) and up to five banking days to examine documents (UCP 600 art. 14(b))` };
}
