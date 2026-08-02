import { readFile, writeFile } from "node:fs/promises";

const sourceUrl = new URL("../data/affiliate-networks.json", import.meta.url);
const programSourceUrl = new URL("../data/affiliate-programs.json", import.meta.url);
const outputUrl = new URL("../data/affiliate-networks.md", import.meta.url);
const [registry, programRegistry] = await Promise.all([
  readFile(sourceUrl, "utf8").then(JSON.parse),
  readFile(programSourceUrl, "utf8").then(JSON.parse)
]);

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
  "payoutReadiness",
  "commissionAccess",
  "canPublish",
  "nextAction",
  "lastCheckedAt",
  "evidenceUrl"
];

const ids = new Set();
const knownStatuses = new Set(Object.keys(registry.statusDefinitions));
const knownPayoutStates = new Set(Object.keys(registry.payoutReadinessDefinitions));
for (const network of registry.networks) {
  for (const field of required) {
    if (!(field in network)) throw new Error(`${network.id ?? "unknown"}: missing ${field}`);
  }
  if (ids.has(network.id)) throw new Error(`Duplicate network id: ${network.id}`);
  ids.add(network.id);
  if (!knownStatuses.has(network.dealDeskStatus)) {
    throw new Error(`${network.id}: unknown dealDeskStatus ${network.dealDeskStatus}`);
  }
  if (!knownPayoutStates.has(network.payoutReadiness)) {
    throw new Error(`${network.id}: unknown payoutReadiness ${network.payoutReadiness}`);
  }
  if (network.canPublish !== (network.dealDeskStatus === "active_payable")) {
    throw new Error(`${network.id}: canPublish must be true exactly when dealDeskStatus is active_payable`);
  }
  if (network.canPublish && !network.commissionAccess) {
    throw new Error(`${network.id}: canPublish requires commissionAccess`);
  }
  if ("accountReference" in network) {
    throw new Error(`${network.id}: accountReference must not be stored in the public register`);
  }
  for (const field of ["officialUrl", "publisherSignupUrl", "dashboardUrl", "evidenceUrl", "ownershipEvidenceUrl"]) {
    const value = network[field];
    if (value != null && !value.startsWith("https://")) {
      throw new Error(`${network.id}: ${field} must be HTTPS or null`);
    }
  }
}

for (const mapping of registry.legacyMappings) {
  if (!ids.has(mapping.canonicalNetworkId)) {
    throw new Error(`Legacy mapping points to unknown network: ${mapping.canonicalNetworkId}`);
  }
}

const aliases = new Map();
for (const mapping of registry.internalIdAliases ?? []) {
  if (!mapping.alias || aliases.has(mapping.alias) || ids.has(mapping.alias)) {
    throw new Error(`Invalid or duplicate internal alias: ${mapping.alias}`);
  }
  if (!ids.has(mapping.canonicalNetworkId)) {
    throw new Error(`Internal alias points to unknown network: ${mapping.canonicalNetworkId}`);
  }
  aliases.set(mapping.alias, mapping.canonicalNetworkId);
}

for (const program of programRegistry.programs ?? []) {
  if (!ids.has(program.network) && !aliases.has(program.network)) {
    throw new Error(`${program.id}: unknown affiliate-program network ${program.network}`);
  }
}

const esc = (value) => String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
const link = (label, url) => {
  const safeLabel = esc(label).replaceAll("[", "&#91;").replaceAll("]", "&#93;");
  return url ? `[${safeLabel}](${url})` : safeLabel;
};
const statusLabel = (status) => status.replaceAll("_", " ");
const publisherRoute = (network) => {
  if (network.publisherSignupUrl) return link("Apply / enroll", network.publisherSignupUrl);
  if (network.dealDeskStatus === "closed") return "Unavailable — closed";
  if (network.id === "shopify-collabs") return "Merchant invite / application only";
  return "—";
};
const rows = (items) => items
  .map((network) => `| ${link(network.name, network.officialUrl)} | ${esc(network.kind.replaceAll("_", " "))} | ${esc(network.regions.join(", "))} | ${esc(statusLabel(network.dealDeskStatus))} | ${esc(statusLabel(network.payoutReadiness))} | ${network.canPublish ? "Yes — program-specific" : "No"} | ${publisherRoute(network)} | ${link("Official source", network.evidenceUrl)} | ${esc(network.lastCheckedAt)} | ${esc(network.nextAction)} |`)
  .join("\n");

const payable = registry.networks.filter((network) => network.canPublish);
const inProgress = registry.networks.filter((network) => ["active_no_payable_program", "active_limited", "pending_review", "onboarding"].includes(network.dealDeskStatus));
const watchlist = registry.networks.filter((network) => ["not_started", "migrating"].includes(network.dealDeskStatus));
const unavailable = registry.networks.filter((network) => ["declined", "closed"].includes(network.dealDeskStatus));

const tableHeader = "| Network / program | Type | Region | DealDesk status | Payout onboarding | Can publish paid offers? | Publisher route | Evidence | Last checked | Next action |\n|---|---|---|---|---|---|---|---|---|---|";
const legacyRows = registry.legacyMappings
  .map((mapping) => {
    const canonical = registry.networks.find((network) => network.id === mapping.canonicalNetworkId);
    return `| ${esc(mapping.legacyNames.join(", "))} | ${link(canonical.name, canonical.officialUrl)} | ${esc(mapping.status.replaceAll("_", " "))} | ${esc(mapping.note ?? "Use the canonical network.")} |`;
  })
  .join("\n");
const ownershipRows = registry.networks
  .filter((network) => network.ownershipNote)
  .map((network) => `| ${link(network.name, network.officialUrl)} | ${esc(network.ownershipNote)} | ${link("Official source", network.ownershipEvidenceUrl)} |`)
  .join("\n");
const aliasRows = (registry.internalIdAliases ?? [])
  .map((mapping) => {
    const canonical = registry.networks.find((network) => network.id === mapping.canonicalNetworkId);
    return `| ${esc(mapping.alias)} | ${link(canonical.name, canonical.officialUrl)} |`;
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

## Declined or unavailable

${tableHeader}
${rows(unavailable)}

## Legacy names and migrations

| Old name | Use now | Status | Note |
|---|---|---|---|
${legacyRows}

## Ownership and platform continuity

| Network | Verified ownership or continuity note | Evidence |
|---|---|---|
${ownershipRows}

## Internal program-ID aliases

| Program register ID | Canonical network / program |
|---|---|
${aliasRows}

## How this list is maintained

- Review every record daily and discover credible additions.
- Use official network pages and authenticated DealDesk dashboards where access exists.
- Change a status only when there is evidence; update the last-checked timestamp only after actually reviewing that record.
- Track payout onboarding separately from merchant approval and link eligibility; unknown is not treated as ready.
- Keep internal account identifiers and login email addresses out of this public register.
- Never store passwords, cookies, tokens, bank details, or tax data here.
- Never infer that a network account makes every merchant payable. Merchant approval and the exact DealDesk tracking link must be verified separately.
- Render this file after editing the JSON source by running the included renderer.
`;

await writeFile(outputUrl, markdown);
console.log(`Validated ${registry.networks.length} records and rendered ${outputUrl.pathname}`);
