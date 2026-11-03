import hudson.model.FreeStyleProject
import hudson.model.ParametersDefinitionProperty
import hudson.model.StringParameterDefinition
import hudson.model.User
import hudson.tasks.Shell
import jenkins.model.Jenkins
import jenkins.security.ApiTokenProperty

def jenkins = Jenkins.get()
def serviceUser = User.getById('argus-service', true)
def serviceToken = System.getenv('ARGUS_JENKINS_SERVICE_TOKEN')?.trim()
if (!serviceToken) {
  throw new IllegalStateException('ARGUS_JENKINS_SERVICE_TOKEN is required')
}
def tokenProperty = serviceUser.getProperty(ApiTokenProperty.class)
if (tokenProperty == null) {
  tokenProperty = new ApiTokenProperty()
  serviceUser.addProperty(tokenProperty)
}
tokenProperty.tokenStore.revokeAllTokens()
tokenProperty.tokenStore.addFixedNewToken(
  'argus-production-readonly',
  serviceToken,
  null,
)
serviceUser.save()

def jobName = 'checkout-api-production'
def job = jenkins.getItem(jobName)
if (job == null) {
  job = jenkins.createProject(FreeStyleProject.class, jobName)
}
job.setDescription('Production-like CI signal used by the governed Argus SSO golden path.')
job.buildersList.replaceBy([
  new Shell('''#!/bin/sh
set -eu
echo "service=checkout-api environment=production"
echo "stage=source-verification repository=argus/argus-dev-sample"
echo "stage=unit-tests result=passed tests=42"
echo "stage=security-gate result=passed policy=argus-dev-default"
echo "deployment_candidate=7b4ad9b22a44e7e00715cc03693582d78130f1f1"
''')
])
job.save()

if (job.getLastBuild() == null) {
  jenkins.getQueue().schedule2(job, 0)
}

def goldenJobName = 'argus-dev-docker-golden-path'
def goldenJob = jenkins.getItem(goldenJobName)
if (goldenJob == null) {
  goldenJob = jenkins.createProject(FreeStyleProject.class, goldenJobName)
}
goldenJob.setDescription('Gitea-backed Argus.Dev CI: immutable commit checkout, tests, Docker image build and signed status callback.')
goldenJob.setConcurrentBuild(false)
goldenJob.removeProperty(ParametersDefinitionProperty.class)
goldenJob.addProperty(new ParametersDefinitionProperty([
  new StringParameterDefinition('REPOSITORY', 'argus/argus-dev-sample', 'Exact Gitea owner/repository slug.'),
  new StringParameterDefinition('BRANCH_NAME', '', 'Argus-created source branch.'),
  new StringParameterDefinition('COMMIT_SHA', '', 'Immutable commit selected by Argus.'),
]))
goldenJob.buildersList.replaceBy([
  new Shell('''#!/bin/sh
set -eu
set +x

case "$REPOSITORY" in
  argus/argus-dev-sample) ;;
  *) echo "Unsupported repository: $REPOSITORY" >&2; exit 2 ;;
esac
case "$BRANCH_NAME" in
  feature/ARGUS-SHOWCASE-*) ;;
  *) echo "Unsupported branch: $BRANCH_NAME" >&2; exit 2 ;;
esac
case "$COMMIT_SHA" in
  *[!0-9a-f]*|'') echo "Invalid commit SHA" >&2; exit 2 ;;
esac

RESULT=FAILURE
IMAGE_TAG="argus-dev-sample:jenkins-${BUILD_NUMBER}"
callback() {
  payload=$(printf '{"repository":{"full_name":"%s"},"branch":"%s","commit_sha":"%s","build":{"number":"%s","job_name":"argus-dev-docker-golden-path","phase":"COMPLETED","result":"%s","full_url":"http://localhost:8081/job/argus-dev-docker-golden-path/%s/"},"image":{"tag":"%s"}}' \
    "$REPOSITORY" "$BRANCH_NAME" "$COMMIT_SHA" "$BUILD_NUMBER" "$RESULT" "$BUILD_NUMBER" "$IMAGE_TAG")
  curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -H "x-jenkins-token: $JENKINS_CI_WEBHOOK_SECRET" \
    --data "$payload" "$ARGUS_JENKINS_CALLBACK_URL"
}
trap callback EXIT

rm -rf source
basic_auth=$(printf '%s:%s' "$GITEA_CLONE_USERNAME" "$GITEA_CLONE_TOKEN" | base64 | tr -d '\n')
git -c "http.extraHeader=Authorization: Basic $basic_auth" clone \
  "$GITEA_CLONE_ORIGIN/$REPOSITORY.git" source
cd source
git checkout --detach "$COMMIT_SHA"
test "$(git rev-parse HEAD)" = "$COMMIT_SHA"

npm ci
npm test
npm run build
docker build \
  --label "org.argus.proof=dev-jenkins-golden-path" \
  --label "org.argus.repository=$REPOSITORY" \
  --label "org.argus.commit=$COMMIT_SHA" \
  --label "org.argus.branch=$BRANCH_NAME" \
  --tag "$IMAGE_TAG" .
docker image inspect "$IMAGE_TAG" --format 'image={{.Id}} tags={{json .RepoTags}}'
RESULT=SUCCESS
''')
])
goldenJob.save()
