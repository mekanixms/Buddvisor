# Security Policy

## Supported Versions

This project is currently in active development. Only the latest version on the default branch is supported with security updates.

## Reporting a Vulnerability

If you believe you have found a security vulnerability, please do **not** open a public GitHub issue.

Instead, report it privately:

- **Email**: create a GitHub Security Advisory (preferred) or email the maintainer(s).

Please include:

- A clear description of the issue and impact
- Steps to reproduce (proof-of-concept if possible)
- Affected versions/commit
- Any suggested mitigation

We will acknowledge receipt and work on a fix as quickly as practical.

## Security Notes (Operational)

Buddvisor includes functionality such as authentication, document upload/processing, and optional agent tools that can execute commands within a constrained workspace. If you deploy this on a network, treat it as an admin-grade application:

- Run behind HTTPS and authentication
- Do not expose it publicly without hardening (reverse proxy, firewall, rate limits)
- Keep secrets out of version control (`.env` must never be committed)
