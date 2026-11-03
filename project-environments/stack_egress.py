"""Public package sources: selected vendor families plus exact shared-CDN hosts.

HTTPS end-to-end; resolve once, reject every private/reserved IP (including
redirect destinations because each needs a new allowed CONNECT). Tests have
no connection to this gateway. No plaintext HTTP or credential forwarding.
"""
import egress

# Keep multi-tenant cloud/CDN providers exact, not *.githubusercontent.com,
# *.microsoft.com, *.google.com, *.amazonaws.com or *.azureedge.net.
ALLOWED = {
    "pypi.org", "files.pythonhosted.org", "astral.sh", "github.com", "api.github.com",
    "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
    "registry.npmjs.org", "registry.yarnpkg.com", "nodejs.org", "bun.sh",
    "cdn.playwright.dev", "playwright.download.prss.microsoft.com", "playwright.azureedge.net",
    "archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com",
    "www.postgresql.org", "apt.postgresql.org",
    "repo.maven.apache.org", "services.gradle.org", "downloads.gradle.org",
    "go.dev", "dl.google.com", "proxy.golang.org", "sum.golang.org", "storage.googleapis.com",
    "static.rust-lang.org", "sh.rustup.rs", "index.crates.io", "static.crates.io",
    "dot.net", "builds.dotnet.microsoft.com", "dotnetcli.azureedge.net", "api.nuget.org",
}

# Operator-owned family policy. Covers new official release/download subdomains
# without opening arbitrary internet destinations or allowing agent overrides.
DOMAIN_FAMILIES = frozenset({
    "astral.sh", "pypi.org", "pythonhosted.org", "nodejs.org", "npmjs.org",
    "yarnpkg.com", "bun.sh", "playwright.dev", "ubuntu.com", "postgresql.org",
    "gradle.org", "go.dev", "golang.org", "rust-lang.org", "rustup.rs",
    "crates.io", "dot.net", "nuget.org",
})


def target(value):
    return egress.target(value, ALLOWED, DOMAIN_FAMILIES)


class Proxy(egress.Proxy):
    resolve_target = staticmethod(target)


if __name__ == "__main__":
    egress.Server(("0.0.0.0", 3128), Proxy).serve_forever()
