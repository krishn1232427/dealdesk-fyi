import { readFile, writeFile } from "node:fs/promises";

const sourceUrl = new URL("../data/affiliate-networks.json", import.meta.url);
const outputUrl = new URL("../data/affiliate-networks.md", import.meta.url);
const registry = JSON.parse(await readFile(sourceUrl, "utf8"));

const required = [
  "id",
  "name",
  "kind",
  "regions",
  "focus",
  "officialUrl",
  "publisherSignupUrl",
  "priority",
  "dealDeskStatus",
  "commissionAccess",
  "canPublish",
  "nextAction",
  "lastCheckedAt",
  "evidenceUrl"
];

const ids = new Set();
for (const network of registry.networks) {
  for (const field of required) {
    if (!(field in network)) throw new Error(`${network.id ?? "unknown"}: missing ${field}`);
  }
  if (ids.has(network.id)) throw new Error(`Duplicate network id: ${network.id}`);
  ids.add(network.id);
  if (network.canPublish && !network.commissionAccess) {
    throw new Error(`${network.id}: canPublish requires commissionAccess`);
  }
  for (const field of ["officialUrl", "publisherSignupUrl", "dashboardUrl", "evidenceUrl"]) {
    const value = network[field];
    if (value !== null && !value.startsWith("https://")) {
      throw new Error(`${network.id}: ${field} must be HTTPS or null`);
    }
  }
}

for (const mapping of registry.legacyMappings) {
  if (!ids.has(mapping.canonicalNetworkId)) {
    throw new Error(`Legacy mapping points to unknown network: ${mapping.canonicalNetworkId}`);
  }
}

const esc = (value) => String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
const link = (label, url) => {
  const safeLabel = esc(label).replaceAll("[", "&#91;").replaceAll("]", "&#93;");
  return url ? `[${safeLabel}](${url})` : safeLabel;
};
const statusLabel = (status) => status.replaceAll("_", " ");
const rows = (items) => items
  .map((network) => `| ${link(network.name, network.officialUrl)} | ${esc(network.kind.replaceAll("_", " "))} | ${esc(network.regions.join(", "))} | ${esc(statusLabel(network.dealDeskStatus))} | ${network.canPublish ? "Yes — program-specific" : "No"} | ${link("Apply / enroll", network.publisherSignupUrl)} | ${esc(network.nextAction)} |`)
  .join("\n");

const payable = registry.networks.filter((network) => network.canPublish);
const inProgress = registry.networks.filter((network) => ["active_no_payable_program", "active_limited", "pending_review", "onboarding"].includes(network.dealDeskStatus));
const watchlist = registry.networks.filter((network) => ["not_started", "migrating"].includes(network.dealDeskStatus));

const tableHeader = "| Network / program | Type | Region | DealDesk status | Can publish paid offers? | Publisher route | Next action |\n|---|---|---|---|---|---|---|";
const legacyRows = registry.legacyMappings
  .map((mapping) => {
    const canonical = registry.networks.find((network) => network.id === mapping.canonicalNetworkId);
    return `| ${esc(mapping.legacyNames.join(", "))} | ${link(canonical.name, canonical.officialUrl)} | ${esc(mapping.status.replaceAll("_", " "))} | ${esc(mapping.note ?? "Use the canonical network.")} |`;
  })
  .join("\n");

const markdown = `# DealDesk affiliate-network register

Last refreshed: ${registry.updatedAt}

This is DealDesk's cumulative working list of ${registry.networks.length} credible affiliate networks, commerce platforms, and important merchant-owned programs. It is refreshed daily because the market is open-ended and networks, signup routes, ownership, and DealDesk approvals change.

**Paid-listing rule:** ${registry.publicationRule}

## Payable access now

${tableHeader}
${rows(payable)}

## Accounts and applications in progress

${tableHeader}
${rows(inProgress)}

## Networks and programs to monitor

${tableHeader}
${rows(watchlist)}

## Legacy names and migrations

| Old name | Use now | Status | Note |
|---|---|---|---|
${legacyRows}

## How this list is maintained

- Review every record daily and discover credible additions.
- Use official network pages and authenticated DealDesk dashboards where access exists.
- Change a status only when there is evidence; update the last-checked timestamp only after actually reviewing that record.
- Never store passwords, cookies, tokens, bank details, or tax data here.
- Never infer that a network account makes every merchant payable. Merchant approval and the exact DealDesk tracking link must be verified separately.
- Render this file after editing the JSON source by running the included renderer.
`;

await writeFile(outputUrl, markdown);
console.log(`Validated ${registry.networks.length} records and rendered ${outputUrl.pathname}`);
