#!/usr/bin/env node
/**
 * Stage-1 scan for the email-auth workflow. Resolves a domain's email-authentication DNS posture —
 * SPF, DMARC, MX, MTA-STS, TLS-RPT, DKIM (common selectors), BIMI — into a scan.json the deterministic
 * evaluator reads. DNS only (no mail sending); a missing record is "absent", not an error. Node builtins.
 *
 * Env: EMAILAUTH_DOMAIN (required), EMAILAUTH_SELECTORS (comma list; default common selectors),
 *   EMAILAUTH_TIMEOUT_MS (default 5000).
 */
import { Resolver } from "node:dns/promises";

const domain = process.env.EMAILAUTH_DOMAIN;
if (!domain) {
  process.stderr.write("scan: EMAILAUTH_DOMAIN is required\n");
  process.exit(1);
}
const selectors = (process.env.EMAILAUTH_SELECTORS || "default,google,selector1,selector2,k1,mail,dkim,s1,s2").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT = Number(process.env.EMAILAUTH_TIMEOUT_MS || 5000);

const resolver = new Resolver({ timeout: TIMEOUT, tries: 2 });

async function txt(name) {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}
async function mx(name) {
  try {
    return await resolver.resolveMx(name);
  } catch {
    return [];
  }
}
const findTxt = (records, prefix) => records.find((r) => r.toLowerCase().startsWith(prefix.toLowerCase())) ?? null;

const rootTxt = await txt(domain);
const spfRecord = findTxt(rootTxt, "v=spf1");
const spf = { present: Boolean(spfRecord), record: spfRecord, qualifier: spfRecord ? (spfRecord.match(/([~\-+?])all\b/)?.[1] ?? null) : null };

const dmarcTxt = await txt(`_dmarc.${domain}`);
const dmarcRecord = findTxt(dmarcTxt, "v=DMARC1");
const dmarc = {
  present: Boolean(dmarcRecord),
  record: dmarcRecord,
  policy: dmarcRecord ? (dmarcRecord.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase() ?? null) : null,
  rua: dmarcRecord ? /\brua=/.test(dmarcRecord) : false,
};

const mxRecords = await mx(domain);
const mtaSts = { present: Boolean(findTxt(await txt(`_mta-sts.${domain}`), "v=STSv1")) };
const tlsRpt = { present: Boolean(findTxt(await txt(`_smtp._tls.${domain}`), "v=TLSRPTv1")) };
const bimi = { present: Boolean(findTxt(await txt(`default._bimi.${domain}`), "v=BIMI1")) };

const found = [];
for (const sel of selectors) {
  const rec = await txt(`${sel}._domainkey.${domain}`);
  if (rec.some((r) => /v=DKIM1|k=rsa|p=/i.test(r))) found.push(sel);
}
const dkim = { selectors_checked: selectors, selectors_found: found };

process.stdout.write(JSON.stringify({ domain, scanned_at: new Date().toISOString(), spf, dmarc, mx: mxRecords, mta_sts: mtaSts, tls_rpt: tlsRpt, dkim, bimi }, null, 2));
