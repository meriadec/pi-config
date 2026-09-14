# Retire the Legacy name hierarchy

Status: accepted

The SQLite cutover will require every retained Topic family to have explicit Parent Topic and Integration Target data. Any unresolved or ambiguous name-derived family blocks migration for human repair. After the live migration is verified, Work removes name-based family rendering, the legacy migration UI and protocol, migration journals, and all permanent compatibility code.

## Consequences

The final control plane has one family model and one Integration Chain model. The temporary storage importer and the old JSON data remain only in a private migration backup, not in production code.
