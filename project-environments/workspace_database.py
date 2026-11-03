"""Trusted, per-run PostgreSQL provisioning; no administrator secret in workers.

The configured disposable Workspace DB must use the exact strict HBA policy.
Administration uses local peer authentication via Docker exec as postgres.
Worker passwords exist only for one offline phase and are revoked before its
receipt is saved. DB names/roles are controller-derived, never request inputs.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import socket
import struct
import tarfile

LABEL = 'io.argus.workspace-database'
PROFILE = 'run-scoped-v1'
HBA_PATH = '/etc/argus/workspace-db.pg_hba.conf'


def identity(owner, thread):
    from stack_contract import UUID
    if not re.fullmatch(r'[a-z0-9-]{1,64}', owner) or not re.fullmatch(UUID, thread):
        raise ValueError('stack_database_binding_changed')
    key = hashlib.sha256((owner + ':' + thread).encode()).hexdigest()
    return 'argus_run_' + key[:32], 'argus.workspace-db:' + owner + ':' + thread, key


def sql(client, container, statement):
    """Bounded psql stdin; never put a password or SQL in argv/log/error text."""
    wire = None
    try:
        invocation = client.api.exec_create(container.id,
            ['psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
            user='postgres', stdin=True, environment=['PGHOST=/var/run/postgresql',
                'PGOPTIONS=-c statement_timeout=5000 -c lock_timeout=1000 -c log_statement=none -c log_min_error_statement=panic -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_duration=off'])
        wire = client.api.exec_start(invocation['Id'], socket=True)
        stream = getattr(wire, '_sock', wire)
        stream.settimeout(15)
        stream.sendall(statement.encode() + b'\n')
        stream.shutdown(socket.SHUT_WR)
        output, size = bytearray(), 0
        def read_exact(length):
            value = bytearray()
            while len(value) < length:
                chunk = stream.recv(length - len(value))
                if not chunk:
                    if not value:
                        return None
                    raise ValueError('truncated Docker stream')
                value.extend(chunk)
            return bytes(value)
        while True:
            header = read_exact(8)
            if header is None:
                break
            channel, length = header[0], struct.unpack('>I', header[4:])[0]
            size += length
            if size > 65536:
                raise ValueError('bounded SQL output exceeded')
            data = read_exact(length) if length else b''
            if data is None:
                raise ValueError('truncated Docker output')
            if channel == 1:
                output.extend(data)
        if client.api.exec_inspect(invocation['Id']).get('ExitCode') != 0:
            raise ValueError('SQL failed')
        return output.decode().strip()
    except Exception:
        raise ValueError('stack_database_unavailable') from None
    finally:
        if wire is not None:
            wire.close()


def configured(runner):
    name = os.environ.get('ARGUS_WORKSPACE_DATABASE_CONTAINER', '')
    if not name:
        return None
    try:
        container = runner.client.containers.get(name)
        if container.attrs.get('Config', {}).get('Labels', {}).get(LABEL) != PROFILE:
            raise ValueError('untrusted database')
        return container
    except Exception:
        raise ValueError('stack_database_policy_required') from None


def validate(runner, database):
    try:
        # Compare the immutable mounted policy AND the server's selected path.
        # Merely inspecting pg_hba_file_rules does not prove the active file.
        mounts = database.attrs.get('Mounts', [])
        if not any(m.get('Destination') == HBA_PATH and m.get('RW') is False for m in mounts):
            raise ValueError('missing immutable HBA')
        stream, _ = database.get_archive(HBA_PATH)
        payload = bytearray()
        for chunk in stream:
            payload.extend(chunk)
            if len(payload) > 32768:
                raise ValueError('HBA too large')
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:*') as tar:
            members = tar.getmembers()
            if len(members) != 1 or not members[0].isfile() or tar.extractfile(members[0]).read() != Path(__file__).with_name('workspace_db.pg_hba.conf').read_bytes():
                raise ValueError('different policy')
        config = json.loads(sql(runner.client, database, "SELECT json_build_object('hba',current_setting('hba_file'),'version',current_setting('server_version_num'),'errors',(SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL));"))
        if config['hba'] != HBA_PATH or config['errors'] != 0:
            raise ValueError('invalid policy')
        major = int(config['version']) // 10000
        if major < 16 or major > 99:
            raise ValueError('unsupported PostgreSQL')
        return major
    except Exception:
        raise ValueError('stack_database_policy_required') from None


class Lease:
    def __init__(self, runner, database, marker):
        from stack_runner import OWNER
        self.runner, self.database, self.marker = runner, database, marker
        self.role, self.comment, self.scope = identity(OWNER, marker['threadId'])
        self.password = secrets.token_hex(32)
        self.connected = False
        self.issued = False
        self.environment = {}

    def prepare(self):
        major = validate(self.runner, self.database)
        query = f"SELECT json_build_object('role',(SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname='{self.role}'),'database',(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{self.role}'),'roleExists',EXISTS(SELECT FROM pg_roles WHERE rolname='{self.role}'),'dbExists',EXISTS(SELECT FROM pg_database WHERE datname='{self.role}'));"
        existing = json.loads(sql(self.runner.client, self.database, query))
        if any(existing[k + 'Exists'] and existing[label] != self.comment for k, label in [('role', 'role'), ('db', 'database')]):
            raise ValueError('stack_database_binding_changed')
        if not existing['roleExists']:
            sql(self.runner.client, self.database, f"BEGIN; CREATE ROLE {self.role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16; COMMENT ON ROLE {self.role} IS '{self.comment}'; COMMIT;")
        if sql(self.runner.client, self.database, f"SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='{self.role}');") != '0':
            raise ValueError('stack_database_binding_changed')
        # Invalidate any previous password/connections before resetting OUR DB.
        self.issued = True
        self.revoke()
        if existing['dbExists']:
            sql(self.runner.client, self.database, f'DROP DATABASE {self.role} WITH (FORCE);')
        # CREATE DATABASE cannot be inside a transaction. A missing provenance
        # comment after process loss intentionally requires operator repair.
        sql(self.runner.client, self.database, f'CREATE DATABASE {self.role} OWNER {self.role} TEMPLATE template0;')
        sql(self.runner.client, self.database, f"COMMENT ON DATABASE {self.role} IS '{self.comment}'; REVOKE ALL ON DATABASE {self.role} FROM PUBLIC;")
        self.issued = True
        # Expiry limits new connections even if the controller disappears.
        # It does not terminate existing sessions; close/recovery does that.
        sql(self.runner.client, self.database, f"SET password_encryption='scram-sha-256'; DO $argus$ BEGIN EXECUTE format('ALTER ROLE {self.role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L VALID UNTIL %L CONNECTION LIMIT 16', '{self.password}', clock_timestamp() + interval '15 minutes'); END $argus$;")
        network = self.runner.client.networks.get(self.marker['networkId'])
        self.connected = True
        network.connect(self.database, aliases=['workspace-db'])
        self.environment = {
            'ARGUS_WORKSPACE_DATABASE': 'postgresql', 'TEST_POSTGRES_HOST': 'workspace-db', 'TEST_POSTGRES_PORT': '5432',
            'TEST_POSTGRES_USER': self.role, 'TEST_POSTGRES_PASSWORD': self.password, 'TEST_POSTGRES_DB': self.role,
            'TEST_POSTGRES_VERSION': str(major), 'PGHOST': 'workspace-db', 'PGPORT': '5432', 'PGUSER': self.role,
            'PGPASSWORD': self.password, 'PGDATABASE': self.role,
            'DATABASE_URL': f'postgresql://{self.role}:{self.password}@workspace-db:5432/{self.role}',
        }
        return {'version': 1, 'engine': 'postgresql', 'serverMajor': major, 'scopeSha256': self.scope, 'reset': 'before-phase'}

    def revoke(self):
        if self.issued:
            sql(self.runner.client, self.database, f"ALTER ROLE {self.role} NOLOGIN PASSWORD NULL; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='{self.role}' AND pid<>pg_backend_pid();")
            self.issued = False

    def close(self):
        # Disconnect even when DB is unavailable; do not report a passing receipt
        # until both revocation and network detachment are confirmed.
        failed = False
        try:
            self.revoke()
        except Exception:
            failed = True
        if self.connected:
            try:
                network = self.runner.client.networks.get(self.marker['networkId'])
                try:
                    network.disconnect(self.database, force=True)
                except Exception:
                    pass  # Confirm the actual state; connect may not have happened.
                network.reload()
                if self.database.id in network.attrs.get('Containers', {}):
                    raise ValueError('database still attached')
                self.connected = False
            except Exception:
                failed = True
        if failed:
            raise ValueError('stack_database_stop_unconfirmed') from None

    def redact(self, result):
        for key in ('stdout', 'stderr'):
            if isinstance(result.get(key), str):
                result[key] = result[key].replace(self.password, '[REDACTED]')
        # Generated files must never turn an ephemeral DB secret into source.
        import base64
        for item in result.get('outputs', []):
            if self.password.encode() in base64.b64decode(item['content']):
                raise ValueError('stack_database_secret_in_output')


def confirm_removed_database_isolation(runner, marker):
    """A Docker 404 for an old DB is not an unavailable database to revoke.

    Retain its binding; never connect an old run to the replacement. Only accept
    the removed DB when its worker is stopped and its private network isolated.
    This inspection must not mutate the replacement DB or any run evidence.
    """
    from docker.errors import NotFound
    from stack_runner import LABEL as WORKER_LABEL, OWNER
    from workspace_session import SESSION_LABEL
    worker = None
    try:
        worker = runner.client.containers.get(marker['containerId'])
        worker.reload()
        labels = worker.attrs.get('Config', {}).get('Labels', {})
        networks = worker.attrs.get('NetworkSettings', {}).get('Networks', {})
        if (worker.id != marker['containerId'] or labels.get(WORKER_LABEL) != OWNER
                or labels.get(SESSION_LABEL) != marker['threadId']
                or worker.attrs.get('State', {}).get('Running') is not False
                or worker.attrs.get('State', {}).get('Paused')
                or any(n.get('NetworkID') != marker['networkId'] for n in networks.values())):
            raise ValueError('stack_database_stop_unconfirmed')
    except NotFound:
        worker = None
    try:
        network = runner.client.networks.get(marker['networkId'])
        network.reload()
        labels = network.attrs.get('Labels', {})
        if (network.id != marker['networkId'] or network.attrs.get('Internal') is not True
                or labels.get(WORKER_LABEL) != OWNER or labels.get(SESSION_LABEL) != marker['threadId']
                or set(network.attrs.get('Containers', {})) - {marker['containerId']}):
            raise ValueError('stack_database_stop_unconfirmed')
    except NotFound:
        if worker is not None:
            raise ValueError('stack_database_stop_unconfirmed') from None


def recover(runner, thread=None):
    """Controller restart revokes old leases; never resumes or drops run data."""
    from workspace_session import session_markers
    from docker.errors import NotFound
    for marker in session_markers(runner.store):
        if thread is not None and marker['threadId'] != thread:
            continue
        db_id = marker.get('databaseContainerId')
        if not db_id:
            continue
        try:
            try:
                database = runner.client.containers.get(db_id)
            except NotFound:
                confirm_removed_database_isolation(runner, marker)
                continue
            validate(runner, database)
            lease = Lease(runner, database, marker)
            exists = sql(runner.client, database, f"SELECT count(*) FROM pg_roles WHERE rolname='{lease.role}' AND shobj_description(oid,'pg_authid')='{lease.comment}';")
            lease.issued = exists == '1'
            network = runner.client.networks.get(marker['networkId'])
            lease.connected = db_id in network.attrs.get('Containers', {})
            lease.close()
        except Exception:
            raise ValueError('stack_database_stop_unconfirmed') from None
