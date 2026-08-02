# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | Yes                |
| < 1.0   | No                 |

## Reporting a Vulnerability

If you discover a security vulnerability in Plexar Studio, please report it responsibly.

### Preferred: GitHub Security Advisories

Report vulnerabilities through [GitHub Security Advisories](../../security/advisories/new). This allows us to discuss and address the issue privately before public disclosure.

### Alternative: Email

If you are unable to use GitHub Security Advisories, you may report vulnerabilities via email to the repository maintainer. See the repository profile for contact information.

### Please do not

- Open a public GitHub issue for security vulnerabilities.
- Disclose the vulnerability publicly before it has been addressed.

## Scope

The following types of vulnerabilities are in scope:

- **Authentication bypass** -- circumventing session auth or API key validation
- **PTY escape** -- breaking out of the terminal sandbox or executing unintended commands
- **Cross-site scripting (XSS)** -- injecting scripts via terminal output or UI inputs
- **Arbitrary code execution** -- gaining code execution outside the intended PTY context

## Response

- **Acknowledgment:** We will acknowledge receipt of your report within **48 hours**.
- **Critical fixes:** Critical vulnerabilities will be patched within **14 days** of confirmation.
- **Disclosure:** We will coordinate with you on public disclosure timing after a fix is available.

## Thank You

We appreciate the efforts of security researchers and contributors who help keep Plexar Studio safe.
