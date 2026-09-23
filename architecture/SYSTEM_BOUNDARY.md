# M03 EBMS System Boundary V1.0

## Identity

M03 EBMS is the management result and decision work surface within AEOS V7.2. It aggregates governed facts; it is not the authoritative execution system for professional domains.

## Allowed capabilities

- Target/Plan
- Result
- Gap/Exception
- Decision
- Action
- Evidence
- Review
- Dashboard/Report
- Cross-domain aggregation through registered contracts
- Evidence traceability

The required management loop is `Target → Result → Gap/Exception → Decision → Action → Result → Evidence → Review`.

## Prohibited expansion

M03 must not add or become the authoritative owner of:

- professional sales execution;
- R&D master-data writes;
- procurement execution;
- financial calculation ownership;
- independent identity, organization, role, or permission expansion.

Existing capabilities in these domains remain available during P0/P1 as legacy-compatible functions. New work must target the owning AEOS module and expose versioned Result, Exception, Event, or Evidence contracts to M03.

## Change gate

Every new M03 capability must identify its contract, source module, fact owner, evidence path, accountable owner, test, and exit condition. Unregistered cross-domain direct reads are prohibited.
