# Legacy Migration Register V1.0

| Legacy capability | Target | Compatibility rule | Replacement contract | Accountable owner | Removal condition |
|---|---|---|---|---|---|
| sales execution routes | M05 | keep current APIs stable | Object/Event/Result V1 | Sales Autonomy Owner | M05 UAT and consumer cutover complete |
| R&D/product/BOM routes | M04 | keep current APIs stable | Object/Event/Result V1 | R&D Autonomy Owner | M04/PLM fact-source cutover complete |
| material/procurement routes | M06/M02 | register every M03 read | Object/Event/Exception V1 | Delivery & Data Owner | governed service replaces direct reads |
| finance calculations | M09 | M03 may display but not redefine | Result V1 with calculation version | Finance Autonomy Owner | finance Result parity and UAT complete |
| local identity/permissions | M01 | retain Bearer-only security | Identity/Policy API | AEOS Kernel Owner | unified login and policy adapter accepted |
| external sync routes | M11/M02 | preserve connector behavior | API/Event V1 | Integration Owner | connector service is independently deployable |
| local audit logs | M02 | preserve records and hashes | Evidence V1 | Data & Evidence Owner | evidence service provides traceable retrieval |

Migration order is logical boundary, contract, API/Event, data ownership, then physical separation. Removal is always a separately reviewed change.
