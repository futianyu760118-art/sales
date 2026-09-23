# Data Ownership Matrix V1.0

| Dataset | Current store | Current writer | Target module | Accountable owner | Fact source | Consumer mode | Migration state | Exit condition |
|---|---|---|---|---|---|---|---|---|
| users/roles/permissions | `database/*.json` | user/permission/organization routes | M01 | AEOS Kernel Owner | M01 identity service | policy API | legacy-compatible | all modules consume one identity contract |
| orders | `database/orders.json` | order/inquiry routes | M05 | Sales Autonomy Owner | M05 order service | Result/Event/API | legacy-compatible | M03 has no direct order-table read |
| customers | `database/customers.json` | customer route | M05 | Sales Autonomy Owner | M05 customer service | Object/API | legacy-compatible | customer writes move behind M05 API |
| products | `database/products.json` | product route | M04 | R&D Autonomy Owner | M04 product service | Object/API | legacy-compatible | product writes move behind M04 API |
| projects | `database/projects.json` | project route | M04 | R&D Autonomy Owner | M04 project service | Result/Event/API | legacy-compatible | M03 has no direct project-table read |
| BOM | `database/bom*.json` | BOM routes | M04 | R&D Autonomy Owner | M04 BOM service | Object/Event/API | legacy-compatible | one authoritative BOM service exists |
| materials | `database/materials.json` | material/import/sync routes | M06/M02 | Delivery & Data Owner | governed material service | Object/Event/API | legacy-compatible | all writes use governed material interface |
| suppliers | `database/suppliers.json` | supplier/procurement routes | M06/M02 | Delivery & Data Owner | supplier service | Object/API | legacy-compatible | supplier master is unique and versioned |
| expenses/labor/material costs | `database/*.json` | finance-related routes | M09 | Finance Autonomy Owner | M09 calculation service | versioned Result | legacy-compatible | M03 consumes calculation-versioned Results only |
| annual plans | `database/annual_*.json` | annual-plan route | M03 | EBMS Owner | M03 target service | local M03 API | retain | governed Target/Plan contract is active |
| AI learning/action records | `database/ai_*.json` | ai-assistant route | M01 | AEOS Kernel Owner | verified Agent/Skill/Memory service | verified Learning API | legacy-compatible | unverified answers cannot enter formal learning |
| audit/evidence records | `database/*logs*.json` | multiple routes | M02 | Data & Evidence Owner | M02 evidence service | Evidence API | transition | evidence IDs, hashes and lineage are governed |

No dataset may gain a second authoritative fact source. Temporary duplication requires an owner, reconciliation rule, and exit condition.
