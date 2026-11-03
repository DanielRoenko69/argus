"""Disposable real Docker recovery fixture. Simulated old-boot marker only.
No production receipts, networks, workspaces or credentials are mounted.
"""
import base64
import json
import os
from pathlib import Path
import tempfile
import uuid
from types import SimpleNamespace
import docker
from stack_contract import digest
from stack_runner import archive, container_options, durable, execute, LABEL, OWNER
from stack_recovery import reconcile, preview, execute_recovered, boot_time

assert OWNER.startswith('recovery-cert-'), 'Dedicated certification owner required'
client=docker.from_env(timeout=60)
base=os.environ['ARGUS_STACK_BASE_IMAGE']
thread=str(uuid.uuid4())
source=b'print("fixture")\n'
import hashlib
request={'version':1,'threadId':thread,'basisSha256':'a'*64,
    'sourceSha256':digest(['b'*40,[['example.py',hashlib.sha256(source).hexdigest()]]]),
    'baseCommitSha':'b'*40,'plan':{'version':1,'summary':'Disposable recovery fixture','setup':'exit 99',
    'start':'test "$(cat /opt/installed-once)" = ready','test':'python3 /repo/example.py','python':'/usr/bin/python3'},
    'phase':'project','source':[{'path':'example.py','content':base64.b64encode(source).decode()}],'probe':'','preparedImage':None}
container=None
try:
    with tempfile.TemporaryDirectory() as folder:
        runner=SimpleNamespace(client=client,store=Path(folder),base=base)
        container=client.containers.create(**container_options(base,'argus-recovery-fixture-'+thread,'none'))
        container.start();container.put_archive('/repo',archive([('example.py',source)]))
        assert execute(client,container,'printf ready >/opt/installed-once',30)['status']=='completed'
        container.stop(timeout=2)
        job=runner.store/digest(request);job.mkdir()
        binding={'version':1,'threadId':thread,'requestSha256':digest(request),'planSha256':digest(request['plan']),
            'sourceSha256':request['sourceSha256'],'containerId':container.id}
        durable(job/'intent.json',{k:binding[k] for k in ['requestSha256','threadId','planSha256']})
        durable(job/'snapshot-started.json',binding)
        durable(job/'snapshot-failure.json',{**binding,'code':'stack_snapshot_unavailable_no_replay'})
        # Only this synthetic fixture simulates a marker from a previous VM boot.
        os.utime(job/'snapshot-started.json',(boot_time()-10,boot_time()-10))
        proof=reconcile(runner,request)
        assert preview(runner,request)==proof
        result=execute_recovered(runner,request)
        assert result['status']=='completed' and result['exitCode']==0 and 'fixture' in result['stdout']
        assert (job/'snapshot-failure.json').exists()
        assert result['preparedImage']==proof['preparedImage']
        print(json.dumps({'passed':True,'realDockerSnapshot':True,'offlineTests':True,'setupNotReplayed':True,
            'originalFailureRetained':True,'simulatedPriorBootMarker':True}))
finally:
    for c in client.containers.list(all=True,filters={'label':LABEL+'='+OWNER}): c.remove(force=True)
    for image in client.images.list(filters={'label':LABEL+'='+OWNER}): client.images.remove(image.id)
