# Security policy

Please report suspected vulnerabilities with a private GitHub Security Advisory. Do not include secrets, customer screenshots, auth state, or private Scene archives in a public issue.

Include the affected package/version, impact, reproduction against synthetic data, and any suggested mitigation. Maintainers should acknowledge a complete report within three business days, establish severity and a remediation owner, and coordinate disclosure after supported versions are patched.

The highest-priority classes are unredacted screenshot persistence, password/credential capture, cross-workspace object access, unsafe archive import, viewer/editor script execution, baseline or Release mutation, OIDC/upload-token confusion, webhook SSRF, and extension remote-code/CSP violations.

See [docs/privacy.md](./docs/privacy.md) for product trust boundaries and secure defaults.
