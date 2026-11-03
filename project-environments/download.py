"""Pinned pip adapter; reject direct links and all source builds before preparation.

The network sandbox is independent of these checks. This guard must be reviewed
and re-certified whenever the pinned pip version changes.
"""
import sys
import resource
from urllib.parse import urlsplit
import pip
from pip._internal.exceptions import InstallationError
from pip._internal.req.req_install import InstallRequirement
from pip._internal.operations.prepare import RequirementPreparer


def protect():
    if pip.__version__ != "25.2":
        raise RuntimeError("environment_resolver_version_mismatch")
    original_init = InstallRequirement.__init__
    original_prepare = RequirementPreparer.prepare_linked_requirement

    def checked_init(self, req, *args, **kwargs):
        if req is not None and req.url:
            raise InstallationError("environment_source_not_allowed")
        original_init(self, req, *args, **kwargs)
        if self.editable:
            raise InstallationError("environment_source_not_allowed")

    def checked_prepare(self, req, *args, **kwargs):
        link = req.link
        url = urlsplit(link.url) if link else None
        if (not link or not link.is_wheel or not url or url.scheme != "https"
                or url.hostname != "files.pythonhosted.org" or url.username or url.password
                or url.port not in {None, 443}):
            raise InstallationError("environment_source_not_allowed")
        return original_prepare(self, req, *args, **kwargs)

    InstallRequirement.__init__ = checked_init
    RequirementPreparer.prepare_linked_requirement = checked_prepare


if __name__ == "__main__":
    # Set inside the child, not preexec_fn in the threaded HTTP parent.
    resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
    resource.setrlimit(resource.RLIMIT_FSIZE, (134217728, 134217728))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    protect()
    from pip._internal.cli.main import main
    sys.exit(main())
