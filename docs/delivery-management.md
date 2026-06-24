# Delivery Management

The Deliverables module bridges project controls and solution delivery. Each deliverable belongs to a project and tracks its overall lifecycle alongside development, SIT, UAT, and deployment status.

## Readiness

Delivery Readiness is calculated as:

`deployed deliverables / total deliverables × 100`

A deliverable is complete when its overall status or deployment status is `Deployed`. UAT or SIT completion alone does not count as deployed delivery.

## Operational integrations

- Executive Control Tower shows Delivery Readiness and a Delivery Watch panel.
- Project Workspace shows readiness, deliverables requiring attention, and an Add Deliverable quick action.
- Project Intelligence detects approaching dates, blockers, invalid SIT/UAT sequencing, and deployment readiness gaps.
- Daily Brief shows Today’s Deliverables Requiring Attention in the page and both email formats.
- Project Trends shows cumulative deployed deliverables across snapshot dates.
- System Health validates the `deliverables` table and seed visibility.

## Persistence

Migration `006_delivery_management.sql` creates the table, indexes, stable `(project_id, deliverable_ref)` key, and the temporary development grants used while authentication is out of scope. Both CR028 seed scripts use `ON CONFLICT` so the nine baseline deliverables can be safely reseeded.

