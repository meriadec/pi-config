# Connect Cancel Setup to the dashboard

Status: done

## Parent

`../PRD.md`

## What to build

Expose the implemented Durable Operation cancellation path as Cancel Setup for active Topic provisioning. The dashboard requests a one-use cancellation confirmation, lets the human approve or reject it, and shows the durable result without pretending that external artifacts were rolled back.

## Acceptance criteria

- [ ] Cancel Setup appears only for active accepted or running provisioning operations.
- [ ] Invoking it shows the exact direct warning that completed checkpoints and external artifacts remain.
- [ ] Approval consumes the one-use confirmation and requests operation cancellation; rejection consumes no cancellation authority and leaves provisioning active.
- [ ] Cancellation state and the final interrupted, cancelled, failed, or completed result remain visible after stream reconnect.
- [ ] Repeated input cannot request or confirm cancellation twice.
- [ ] Closing the dashboard stops only client observation and does not implicitly cancel Setup.
- [ ] Public action, component, operation, reconnect, rejection, and cleanup tests cover the production path.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
