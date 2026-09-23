# Current → Target Route Mapping V1.0

Source: `backend/routes/index.js` at the P0 baseline. `legacy-compatible` means the route remains operational but accepts no new domain ownership in M03.

| Route | Current responsibility | Target | P0/P1 state |
|---|---|---|---|
| `/inquiries` | inquiry execution | M05 | legacy-compatible |
| `/products` | product master/execution | M04 | legacy-compatible |
| `/customers` | customer master/execution | M05 | legacy-compatible |
| `/materials` | material execution/master | M06/M02 | legacy-compatible |
| `/material-costs` | material cost calculation | M09 | legacy-compatible |
| `/materials-ext` | material extension | M06/M02 | legacy-compatible |
| `/procurement` | procurement execution | M06 | legacy-compatible |
| `/suppliers` | supplier execution/master | M06/M02 | legacy-compatible |
| `/external-api` | external connector | M11 | legacy-compatible |
| `/orders` | commercial order execution | M05 | legacy-compatible |
| `/samples` | sample execution | M04 | legacy-compatible |
| `/projects` | R&D project execution | M04 | legacy-compatible |
| `/annual-plan` | target and management review | M03 | retain |
| `/amiba` | operating accounting | M09 | legacy-compatible |
| `/products/bom-types` | BOM classification | M04 | legacy-compatible |
| `/products/bom-issues` | BOM exception execution | M04 | legacy-compatible |
| `/pricing` | sales pricing | M05 | legacy-compatible |
| `/quote` | quotation execution | M05 | legacy-compatible |
| `/users` | identity administration | M01 | legacy-compatible |
| `/reports` | management result display | M03 | retain |
| `/import` | data import | M11/M02 | legacy-compatible |
| `/permissions` | permission administration | M01 | legacy-compatible |
| `/feedback` | feedback intake | M03 | retain |
| `/settings` | local settings | M01/M12 | legacy-compatible |
| `/test` | development diagnostics | M12 | development-only |
| `/compliance` | compliance controls | M12 | legacy-compatible |
| `/configs` | runtime configuration | M12 | legacy-compatible |
| `/chat` | collaboration | M01 | legacy-compatible |
| `/rules` | local rules | M01 | legacy-compatible |
| `/spec-library` | specification library | M04/M02 | legacy-compatible |
| `/data-clean` | data quality execution | M02 | legacy-compatible |
| `/ai-assistant` | agent/learning prototype | M01 | legacy-compatible |
| `/bom` | BOM execution | M04 | legacy-compatible |
| `/external-sync` | external synchronization | M11/M02 | legacy-compatible |
| `/external` | external service connector | M11 | legacy-compatible |
| `/tech` | technical transfer | M04 | legacy-compatible |
| `/organization` | identity and organization | M01 | legacy-compatible |
| `/data-scope` | data policy | M01 | legacy-compatible |
| `/material-check` | material health execution | M06 | legacy-compatible |
| `/expenses` | professional finance | M09 | legacy-compatible |
| `/labor` | labor cost calculation | M09 | legacy-compatible |
| `/product-labor-rate` | product labor rate | M09 | legacy-compatible |
| `/material-issues` | material exception execution | M06 | legacy-compatible |
| `/order-analysis` | order analysis | M03/M05 | retain aggregation only |
| `/order-check` | order delivery check | M03A/M06 | legacy-compatible |
| `/sop` | S&OP | M03A | controlled submodule |
| `/im` | instant messaging | M01 | legacy-compatible |

## Enforcement

This table is complete only when every `router.use()` prefix is present. Additions require a target module and P0/P1 state before merge.
