"""Independent behavioral oracle for pallets/click issue #2971.

Run this file with the Python environment of the checked-out Click repository.
The historical parent must fail; an accepted implementation must pass.
"""

import click
from click.testing import CliRunner


def invoke_invalid_option(*, envvar: str | None) -> str:
    option = click.Option(
        ["--value"],
        envvar=envvar,
        show_envvar=True,
        type=click.INT,
    )
    command = click.Command("cli", params=[option])
    result = CliRunner().invoke(command, ["--value", "not-an-int"])
    assert result.exit_code == 2
    return result.output


without_envvar = invoke_invalid_option(envvar=None)
assert "env var: 'None'" not in without_envvar
assert "Invalid value for '--value'" in without_envvar

with_envvar = invoke_invalid_option(envvar="CLICK_VALUE")
assert "env var: 'CLICK_VALUE'" in with_envvar

print("Click #2971 behavior accepted")
