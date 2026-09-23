# ADR-001: Progressive AEOS Separation

- Status: Accepted
- Date: 2026-09-23

## Context

The repository currently combines M03 management capabilities with execution functions owned by M01, M02, M04, M05, M06, M09, M11 and M12. Immediate physical separation would create migration and business-continuity risk, while continued unrestricted growth would make EBMS a second ERP fact source.

## Decision

Separate progressively: freeze logical boundaries, establish versioned contracts, introduce API/Event and legacy adapters, transfer data ownership, then decide physical repository/service separation.

## Rejected alternatives

- Immediate microservice split: rejected because fact ownership and contracts are not yet stable.
- Continue as an unrestricted monolith: rejected because it violates M03 boundaries and creates conflicting professional metrics.

## Consequences

Existing routes stay operational during P0/P1. New M03 APIs are feature-flagged. Temporary cross-domain reads must be registered, observable and removable.
