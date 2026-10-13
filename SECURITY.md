# Security

Report a suspected security issue through the repository's GitHub security advisory flow when available. If private reporting is unavailable, contact the repository owner privately before disclosing sensitive details in a public issue.

The workspace analyzer reads caller-selected local files. REA engine operations have their own filesystem, runtime and network effects. Treat the MCP server as a trusted local tool, not an authenticated remote service. The dashboard is a read-only loopback interface.

Snapshots and reports can contain target paths and extracted strings. HAR metadata intentionally omits headers, bodies, credentials and query values. That omission does not imply general secret detection. Inspect exported data before distributing it.
