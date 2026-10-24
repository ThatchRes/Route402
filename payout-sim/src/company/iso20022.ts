// Every approved payment can be exported as an ISO 20022 customer credit transfer initiation (pain.001.001.09).
// ISO 20022 is the message standard Fedwire (July 2025), CHIPS and Swift cross-border payments now run on, and Quant's
// Overledger messaging is described as ISO 20022-aligned. Keeping each payment in this shape now means the same
// instruction can go to a wire today and to a tokenized-deposit network later without re-keying supplier data.
import type { Beneficiary } from "./validate.js";

const x = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));

export interface Pain001Input {
  msgId: string; createdAt: string; debtorName: string; debtorAccountRef: string; executionDate: string;
  endToEndId: string; amount: string; ccy: string; beneficiary: Beneficiary; invoiceRef: string;
  condition?: { kind: string; evidence: string } | null;
}

/** Fields a supplier record needs before a payment can be sent on ANY rail; what is missing is listed. */
export function readiness(b: Beneficiary) {
  const missing: string[] = [];
  if (!b.name) missing.push("creditor name");
  if (!b.country) missing.push("creditor country");
  if (!b.iban && !b.accountNumber && !b.usdcWallet) missing.push("creditor account");
  if (!b.iban && !b.swift && !b.routing && !b.usdcWallet) missing.push("creditor bank identifier (BIC or routing)");
  return { complete: missing.length === 0, missing };
}

export function pain001(p: Pain001Input): string {
  const b = p.beneficiary, acct = (b.iban ?? "").replace(/\s+/g, "");
  const cdtrAcct = acct ? `<CdtrAcct><Id><IBAN>${x(acct)}</IBAN></Id></CdtrAcct>`
    : b.accountNumber ? `<CdtrAcct><Id><Othr><Id>${x(b.accountNumber.replace(/[\s-]/g, ""))}</Id></Othr></Id></CdtrAcct>` : "";
  const cdtrAgt = b.swift ? `<CdtrAgt><FinInstnId><BICFI>${x(b.swift)}</BICFI></FinInstnId></CdtrAgt>`
    : b.routing ? `<CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${x(b.routing)}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>`
    : `<CdtrAgt><FinInstnId><PstlAdr><Ctry>${x(b.country)}</Ctry></PstlAdr></FinInstnId></CdtrAgt>`;
  // pain.001 has no element for a release condition; it is carried as structured remittance text and, separately, as the
  // ConditionSpec record that a tokenized-deposit network could enforce on the ledger.
  const cond = p.condition ? `<AddtlRmtInf>CONDITION:${x(p.condition.kind)};EVIDENCE:${x(p.condition.evidence)}</AddtlRmtInf>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr><MsgId>${x(p.msgId)}</MsgId><CreDtTm>${x(p.createdAt.slice(0, 19))}</CreDtTm><NbOfTxs>1</NbOfTxs><CtrlSum>${x(p.amount)}</CtrlSum><InitgPty><Nm>${x(p.debtorName)}</Nm></InitgPty></GrpHdr>
    <PmtInf>
      <PmtInfId>${x(p.msgId)}-1</PmtInfId><PmtMtd>TRF</PmtMtd>
      <ReqdExctnDt><Dt>${x(p.executionDate.slice(0, 10))}</Dt></ReqdExctnDt>
      <Dbtr><Nm>${x(p.debtorName)}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${x(p.debtorAccountRef)}</Id></Othr></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><Nm>Company's own bank</Nm></FinInstnId></DbtrAgt>
      <CdtTrfTxInf>
        <PmtId><EndToEndId>${x(p.endToEndId)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${x(p.ccy)}">${x(p.amount)}</InstdAmt></Amt>
        ${cdtrAgt}
        <Cdtr><Nm>${x(b.name)}</Nm><PstlAdr><Ctry>${x(b.country)}</Ctry></PstlAdr></Cdtr>
        ${cdtrAcct}
        <RmtInf><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp><Nb>${x(p.invoiceRef)}</Nb></RfrdDocInf>${cond}</Strd></RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}
