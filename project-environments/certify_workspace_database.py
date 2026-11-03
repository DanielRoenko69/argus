"""Adversarial SQL checks from a real credential-free fixture worker network."""
import json
import uuid
from stack_runner import execute, LABEL, OWNER
from workspace_database import Lease, configured, sql, validate


def verify_boundaries(runner, worker, marker, project, qa):
    database = configured(runner)
    assert project['workspaceDatabase'] == qa['workspaceDatabase']
    assert project['workspaceDatabase']['serverMajor'] == 18
    network = runner.client.networks.create(OWNER + '-second', internal=True, labels={LABEL: OWNER})
    other = Lease(runner, database, {**marker, 'threadId': str(uuid.uuid4()), 'networkId': network.id})
    own = Lease(runner, database, marker)
    try:
        other.prepare()
        own.prepare()
        assert sql(runner.client, database, f"SELECT rolvaliduntil > now() AND rolvaliduntil <= now() + interval '15 minutes' FROM pg_roles WHERE rolname='{own.role}';") == 't'
        worker.start()
        env = {**own.environment, 'OTHER_DB': other.role}
        # Correct own role works. Knowing another run's database name does not
        # authorize access to it: HBA binds db=user and requires its password.
        script = '''test "$(psql -XAtc 'SELECT current_database()')" = "$PGDATABASE"
psql -X -v ON_ERROR_STOP=1 -c 'CREATE TABLE allowed(value int); INSERT INTO allowed VALUES (7);' >/dev/null
if psql -X -d "$OTHER_DB" -c 'SELECT 1' >/dev/null 2>&1; then exit 10; fi
if psql -X -U postgres -d postgres -c 'SELECT 1' >/dev/null 2>&1; then exit 11; fi
if psql -X -v ON_ERROR_STOP=1 -c 'CREATE ROLE escalation LOGIN SUPERUSER' >/dev/null 2>&1; then exit 12; fi
if psql -X -v ON_ERROR_STOP=1 -c 'CREATE DATABASE unauthorized' >/dev/null 2>&1; then exit 13; fi
if PGPASSWORD=wrong psql -X -c 'SELECT 1' >/dev/null 2>&1; then exit 14; fi
if PGUSER="$OTHER_DB" PGDATABASE="$OTHER_DB" psql -X -c 'SELECT 1' >/dev/null 2>&1; then exit 15; fi
'''
        result = execute(runner.client, worker, script, 30, environment=env)
        assert result['status'] == 'completed', result['status']
        # A leaked revoked password cannot reconnect. Keep only the private
        # network attached to distinguish auth rejection from network failure.
        own.revoke()
        expired = execute(runner.client, worker, "if psql -X -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi", 10, environment=env)
        assert expired['status'] == 'completed'
        own.close()
        other.close()
        # A new phase really resets data rather than inheriting project success.
        own = Lease(runner, database, marker)
        own.prepare()
        reset = execute(runner.client, worker, "test \"$(psql -XAtc \"SELECT count(*) FROM information_schema.tables WHERE table_name='allowed'\")\" = 0", 10, environment=own.environment)
        assert reset['status'] == 'completed'
        redacted = {'stdout': own.password, 'stderr': 'postgresql://user:' + own.password + '@workspace-db/db'}
        own.redact(redacted)
        assert own.password not in json.dumps(redacted)
        # Before close, emulate controller process loss: recovery only revokes
        # and disconnects; it never replays source, tests or drops their DB.
        from workspace_database import recover
        recover(runner)
        assert sql(runner.client, database, f"SELECT rolcanlogin FROM pg_roles WHERE rolname='{own.role}';") == 'f'
        own.connected = own.issued = False
        print(json.dumps({'workspaceDatabase': 'passed', 'negativeChecks': ['cross-database', 'administrator', 'create-role', 'create-database', 'wrong-password', 'foreign-role', 'revoked-password'],
                          'freshDatabase': True, 'restartRevocation': True, 'credentialRedaction': True}))
    finally:
        worker.stop(timeout=2)
        own.close()
        other.close()
        network.remove()
